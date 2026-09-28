// Parses Simple Discord Link (SDLink) messages from the Discord channel.
// Default SDLink lines:
//   "Tenez10 has joined the server!"   "Tenez10 has left the server!"
//   "Server has started. Enjoy!"       "Server has stopped..."
// Messages may be wrapped in markdown (*italic*, **bold**) or posted as embeds.

const NAME = "(\\.?[A-Za-z0-9_]{2,16})"; // Java names; leading "." for Bedrock/Floodgate
const JOIN_RE = new RegExp(`^${NAME} (?:has )?joined the (?:server|game)[!.]*$`, "i");
const LEAVE_RE = new RegExp(`^${NAME} (?:has )?left the (?:server|game)[!.]*$`, "i");
const STOP_RE = /^server (?:has )?stopped\b/i;
const START_RE = /^server (?:has )?started\b/i;

export function cleanLine(text) {
  return String(text || "")
    .replace(/<a?:\w+:\d+>/g, "")         // custom emoji
    .replace(/[*_`~>|]/g, "")              // markdown
    .replace(/\s+/g, " ")
    .trim();
}

// Returns every text fragment in a Discord message worth checking.
export function messageTexts(msg) {
  const out = [];
  if (msg.content) out.push(...String(msg.content).split("\n"));
  for (const e of msg.embeds || []) {
    if (e.author?.name) out.push(e.author.name);
    if (e.title) out.push(e.title);
    if (e.description) out.push(...String(e.description).split("\n"));
  }
  return out.map(cleanLine).filter(Boolean);
}

// -> { kind: 'join'|'leave'|'server_start'|'server_stop', username|null } | null
export function parseLine(line) {
  let m;
  if ((m = line.match(JOIN_RE))) return { kind: "join", username: m[1] };
  if ((m = line.match(LEAVE_RE))) return { kind: "leave", username: m[1] };
  if (STOP_RE.test(line)) return { kind: "server_stop", username: null };
  if (START_RE.test(line)) return { kind: "server_start", username: null };
  return null;
}

export function parseMessage(msg) {
  const seen = new Set();
  const events = [];
  for (const line of messageTexts(msg)) {
    const ev = parseLine(line);
    if (!ev) continue;
    const key = ev.kind + ":" + ev.username;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ ...ev, messageId: msg.id, at: msg.timestamp });
  }
  return events;
}
