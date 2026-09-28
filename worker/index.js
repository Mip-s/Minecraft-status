import { parseMessage } from "./parse.js";
import { sendPush } from "./webpush.js";

const DISCORD_API = "https://discord.com/api/v10";
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

// ---------------- Supabase (REST, service role) ----------------
async function sb(env, path, { method = "GET", body, prefer } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`; // legacy JWT key
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getState(env, key) {
  const rows = await sb(env, `monitor_state?key=eq.${key}&select=value`);
  return rows?.[0]?.value ?? null;
}

async function setState(env, entries) {
  const now = new Date().toISOString();
  await sb(env, "monitor_state?on_conflict=key", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: Object.entries(entries).map(([key, value]) => ({ key, value, updated_at: now })),
  });
}

// ---------------- Discord ----------------
async function discordGet(env, path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "User-Agent": "minecraft-monitor (cloudflare worker, 1.0)" },
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.min(5000, (j.retry_after ?? 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error("Discord rate limited");
}

const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

async function fetchNewMessages(env, lastId) {
  const ch = env.DISCORD_CHANNEL_ID;
  if (!lastId) {
    // First run: backfill the most recent messages without sending alerts.
    return (await discordGet(env, `/channels/${ch}/messages?limit=100`)).sort(byId);
  }
  const all = [];
  let after = lastId;
  for (let page = 0; page < 10; page++) {
    const batch = (await discordGet(env, `/channels/${ch}/messages?after=${after}&limit=100`)).sort(byId);
    all.push(...batch);
    if (batch.length < 100) break;
    after = batch[batch.length - 1].id;
  }
  return all;
}

// ---------------- Poll ----------------
async function poll(env) {
  const lastId = await getState(env, "last_message_id");
  const silent = !lastId;
  const messages = await fetchNewMessages(env, lastId);

  const allowed = (env.SOURCE_AUTHOR_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fresh = [];
  for (const msg of messages) {
    if (allowed.length && !allowed.includes(msg.author?.id) && !allowed.includes(msg.webhook_id)) continue;
    for (const ev of parseMessage(msg)) {
      const inserted = await sb(env, "rpc/record_event", {
        method: "POST",
        body: { p_msg_id: ev.messageId, p_user: ev.username, p_kind: ev.kind, p_at: ev.at },
      });
      const ageMin = (Date.now() - Date.parse(ev.at)) / 60000;
      if (inserted && !silent && ageMin < 15) fresh.push(ev);
    }
  }

  const state = { last_poll_at: new Date().toISOString(), last_error: "" };
  if (messages.length) state.last_message_id = messages[messages.length - 1].id;
  await setState(env, state);

  if (fresh.length) await notify(env, fresh);
  return { messages: messages.length, events: fresh.length, silent };
}

// ---------------- Push ----------------
function describe(ev) {
  if (ev.kind === "join") return `${ev.username} joined`;
  if (ev.kind === "leave") return `${ev.username} left`;
  if (ev.kind === "server_stop") return "Server stopped";
  return "Server started";
}

async function notify(env, events) {
  const subs = await sb(env, "push_subscriptions?select=id,endpoint,p256dh,auth");
  if (!subs?.length) return;
  const online = await sb(env, "players?is_online=eq.true&select=username&order=online_since.asc");
  const names = online.map((p) => p.username);
  const onlineText = names.length ? `Online (${names.length}): ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}` : "Nobody online";

  const payloads = events.length <= 3
    ? events.map((ev) => ({ title: describe(ev), body: onlineText, tag: `mc-${ev.kind}-${ev.username ?? "server"}`, url: "/" }))
    : [{ title: `${events.length} server updates`, body: `${events.map(describe).slice(-4).join(" · ")}\n${onlineText}`, tag: "mc-batch", url: "/" }];

  const vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
  const dead = new Set();
  await Promise.all(subs.map(async (sub) => {
    for (const p of payloads) {
      try {
        const status = await sendPush(sub, p, vapid);
        if (status === 404 || status === 410) { dead.add(sub.id); return; }
      } catch (e) {
        console.error("push failed", sub.id, e.message);
      }
    }
  }));
  if (dead.size) await sb(env, `push_subscriptions?id=in.(${[...dead].join(",")})`, { method: "DELETE" });
}

// ---------------- HTTP API ----------------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function validSubscription(s) {
  if (!s || typeof s.endpoint !== "string" || !s.keys?.p256dh || !s.keys?.auth) return false;
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === "/api/config") {
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY, supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_PUBLISHABLE_KEY });
  }

  if (path === "/api/status") {
    const rows = await sb(env, "monitor_state?select=key,value,updated_at&key=in.(last_poll_at,last_error)");
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return json({ lastPollAt: s.last_poll_at || null, lastError: s.last_error || null });
  }

  if (request.method !== "POST") return json({ error: "not found" }, 404);
  const body = await request.json().catch(() => null);

  if (path === "/api/subscribe") {
    if (!validSubscription(body)) return json({ error: "invalid subscription" }, 400);
    await sb(env, "push_subscriptions?on_conflict=endpoint", {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth },
    });
    return json({ ok: true });
  }

  if (path === "/api/unsubscribe") {
    if (typeof body?.endpoint !== "string") return json({ error: "missing endpoint" }, 400);
    await sb(env, `push_subscriptions?endpoint=eq.${encodeURIComponent(body.endpoint)}`, { method: "DELETE" });
    return json({ ok: true });
  }

  if (path === "/api/test-push") {
    // Only ever pushes to the caller's own subscription.
    if (typeof body?.endpoint !== "string") return json({ error: "missing endpoint" }, 400);
    const rows = await sb(env, `push_subscriptions?endpoint=eq.${encodeURIComponent(body.endpoint)}&select=endpoint,p256dh,auth`);
    if (!rows.length) return json({ error: "not subscribed" }, 404);
    const status = await sendPush(rows[0], { title: "Alerts are on", body: "You'll get a notification when someone joins or leaves.", tag: "mc-test", url: "/" },
      { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT });
    return json({ ok: status < 300, status });
  }

  return json({ error: "not found" }, 404);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPolls(env) {
  const n = Math.max(1, Math.min(4, Number(env.POLLS_PER_RUN || 2)));
  const gap = 60000 / n;
  for (let i = 0; i < n; i++) {
    const started = Date.now();
    try {
      await poll(env);
    } catch (e) {
      console.error("poll failed:", e.message);
      await setState(env, { last_error: `${new Date().toISOString()} ${e.message}`.slice(0, 500) }).catch(() => {});
    }
    if (i < n - 1) await sleep(Math.max(0, gap - (Date.now() - started)));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error(e);
        return json({ error: "server error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runPolls(env));
  },
};
