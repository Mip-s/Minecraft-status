import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { usePush } from "./push.js";

// ---------- formatting ----------
const avatarFallback = (e) => { e.currentTarget.onerror = null; e.currentTarget.src = "/icon.svg"; };
const head = (name) => `https://mc-heads.net/avatar/${encodeURIComponent(name.replace(/^\./, ""))}/64`;

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

function fmtAgo(ts, now) {
  const s = (now - new Date(ts).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// ---------- data ----------
function useMonitorData() {
  const [client, setClient] = useState(null);
  const [data, setData] = useState({ players: [], events: [], stats: null, loaded: false, error: null });
  const [status, setStatus] = useState(null);
  const [live, setLive] = useState(false);
  const [config, setConfig] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((cfg) => {
      setConfig(cfg);
      setClient(createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } }));
    }).catch((e) => setData((d) => ({ ...d, error: e.message, loaded: true })));
  }, []);

  const load = useCallback(async () => {
    if (!client) return;
    const [p, e, s] = await Promise.all([
      client.from("players").select("*").order("last_seen", { ascending: false }),
      client.from("events").select("id,username,kind,at").order("at", { ascending: false }).limit(80),
      client.from("today_stats").select("*").single(),
    ]);
    const err = p.error || e.error || s.error;
    setData({ players: p.data || [], events: e.data || [], stats: s.data, loaded: true, error: err?.message || null });
  }, [client]);

  const loadStatus = useCallback(() => {
    fetch("/api/status").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (!client) return;
    load(); loadStatus();
    const soon = () => { clearTimeout(timer.current); timer.current = setTimeout(load, 300); };
    const ch = client.channel("monitor")
      .on("postgres_changes", { event: "*", schema: "public", table: "players" }, soon)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, soon)
      .subscribe((st) => setLive(st === "SUBSCRIBED"));
    const poll = setInterval(() => { load(); loadStatus(); }, 60000);
    const onVis = () => { if (document.visibilityState === "visible") { load(); loadStatus(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { client.removeChannel(ch); clearInterval(poll); document.removeEventListener("visibilitychange", onVis); };
  }, [client, load, loadStatus]);

  return { ...data, status, live, config, reload: () => { load(); loadStatus(); } };
}

// ---------- components ----------
function MonitorPill({ status, live, now }) {
  const last = status?.lastPollAt ? new Date(status.lastPollAt).getTime() : 0;
  const stale = !last || now - last > 3 * 60000;
  const cls = status?.lastError ? "bad" : stale ? "warn" : "ok";
  const label = !status ? "Connecting…" : status.lastError ? "Monitor error" : stale ? "Monitor not checking" : `Checked ${fmtAgo(last, now)}`;
  return (
    <span className={`pill ${cls}`} title={status?.lastError || (live ? "Live updates connected" : "Live updates reconnecting")}>
      <span className="dot" /> {label}
    </span>
  );
}

function AlertsButton({ push }) {
  if (!push.supported) {
    return push.iosNeedsInstall
      ? <span className="hint">To get alerts on iPhone: Share → Add to Home Screen, then open it from there.</span>
      : null;
  }
  if (push.permission === "denied") return <span className="hint">Notifications are blocked in your browser settings.</span>;
  return push.subscribed ? (
    <div className="btn-row">
      <button className="btn ghost" onClick={push.test} disabled={push.busy}>Test</button>
      <button className="btn ghost" onClick={push.unsubscribe} disabled={push.busy}>Alerts on · turn off</button>
    </div>
  ) : (
    <button className="btn primary" onClick={push.subscribe} disabled={push.busy}>
      {push.busy ? "Enabling…" : "Enable alerts"}
    </button>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function OnlineGrid({ players, now }) {
  if (!players.length) return <div className="empty">Nobody is online right now.</div>;
  return (
    <div className="grid">
      {players.map((p) => (
        <div className="card" key={p.username}>
          <img className="avatar" src={head(p.username)} alt="" onError={avatarFallback} loading="lazy" width="48" height="48" />
          <div className="card-body">
            <div className="name">{p.username}</div>
            <div className="muted">Joined {fmtTime(p.online_since)} · {fmtDuration((now - new Date(p.online_since)) / 1000)}</div>
          </div>
          <span className="online-dot" aria-label="online" />
        </div>
      ))}
    </div>
  );
}

const KIND = {
  join: { icon: "→", text: "joined", cls: "join" },
  leave: { icon: "←", text: "left", cls: "leave" },
  server_stop: { icon: "■", text: "Server stopped", cls: "server" },
  server_start: { icon: "▶", text: "Server started", cls: "server" },
};

function Feed({ events, now }) {
  if (!events.length) return <div className="empty">No activity yet. Joins and leaves show up here.</div>;
  let lastDay = null;
  return (
    <ul className="feed">
      {events.map((e) => {
        const k = KIND[e.kind];
        const day = new Date(e.at).toDateString();
        const showDay = day !== lastDay;
        lastDay = day;
        return (
          <li key={e.id}>
            {showDay && <div className="feed-day">{new Date(e.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>}
            <div className={`feed-row ${k.cls}`}>
              <span className="feed-icon">{k.icon}</span>
              {e.username ? (
                <>
                  <img className="avatar sm" src={head(e.username)} alt="" onError={avatarFallback} loading="lazy" width="20" height="20" />
                  <span><b>{e.username}</b> {k.text}</span>
                </>
              ) : <span className="muted">{k.text}</span>}
              <time className="muted" title={new Date(e.at).toLocaleString()}>{fmtAgo(e.at, now)}</time>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PlayerTable({ players, now }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("last_seen");
  const rows = useMemo(() => {
    const f = players.filter((p) => p.username.toLowerCase().includes(q.trim().toLowerCase()));
    const live = (p) => p.total_seconds + (p.is_online ? (now - new Date(p.online_since)) / 1000 : 0);
    return f.sort((a, b) =>
      sort === "playtime" ? live(b) - live(a)
      : sort === "joins" ? b.join_count - a.join_count
      : sort === "name" ? a.username.localeCompare(b.username)
      : (b.is_online - a.is_online) || new Date(b.last_seen) - new Date(a.last_seen));
  }, [players, q, sort, now]);

  return (
    <>
      <div className="table-tools">
        <input className="search" placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
          <option value="last_seen">Last seen</option>
          <option value="playtime">Playtime</option>
          <option value="joins">Joins</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Player</th><th>Last seen</th><th className="num">Joins</th><th className="num">Playtime</th><th>First seen</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.username}>
                <td><div className="player-cell"><img className="avatar sm" src={head(p.username)} alt="" onError={avatarFallback} loading="lazy" width="20" height="20" />{p.username}</div></td>
                <td>{p.is_online ? <span className="tag-online">Online</span> : fmtAgo(p.last_seen, now)}</td>
                <td className="num">{p.join_count}</td>
                <td className="num">{fmtDuration(p.total_seconds + (p.is_online ? (now - new Date(p.online_since)) / 1000 : 0))}</td>
                <td className="muted">{new Date(p.first_seen).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="5" className="empty">No players found.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function App() {
  const now = useNow(1000);
  const d = useMonitorData();
  const push = usePush(d.config?.vapidPublicKey);
  const online = useMemo(
    () => d.players.filter((p) => p.is_online).sort((a, b) => new Date(a.online_since) - new Date(b.online_since)),
    [d.players]
  );
  const s = d.stats;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src="/icon.svg" alt="" width="32" height="32" />
          <div>
            <h1>Server Monitor</h1>
            <MonitorPill status={d.status} live={d.live} now={now} />
          </div>
        </div>
        <AlertsButton push={push} />
      </header>
      {push.error && <div className="banner">{push.error}</div>}
      {d.error && <div className="banner">Couldn't load data: {d.error}</div>}

      <section className="stats">
        <Stat label="Online now" value={online.length} />
        <Stat label="Players today" value={s?.unique_today ?? "–"} />
        <Stat label="Peak today" value={s?.peak_today ?? "–"} />
        <Stat label="Playtime today" value={s ? fmtDuration(s.playtime_today_seconds) : "–"} />
        <Stat label="All-time players" value={s?.total_players ?? "–"} />
      </section>

      <main className="layout">
        <section className="panel">
          <h2>Online now <span className="count">{online.length}</span></h2>
          {d.loaded ? <OnlineGrid players={online} now={now} /> : <div className="empty">Loading…</div>}
        </section>
        <aside className="panel">
          <h2>Activity</h2>
          <Feed events={d.events} now={now} />
        </aside>
        <section className="panel wide">
          <h2>All players</h2>
          <PlayerTable players={d.players} now={now} />
        </section>
      </main>

      <footer className="foot">
        Join/leave events come from the server's Discord channel (Simple Discord Link). Times shown in your local time.
      </footer>
    </div>
  );
}
