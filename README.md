# Minecraft Server Monitor

Public dashboard + phone alerts for who joins/leaves the server.

```
Minecraft (AMP, Hetzner) ──SDLink──▶ Discord channel
                                         │  (Worker cron polls every ~30 s)
                                         ▼
                   Cloudflare Worker "minecraft-monitor"
                     ├─ parses "X has joined/left the server!"
                     ├─ writes to Supabase (record_event)
                     ├─ sends Web Push to subscribed phones
                     └─ serves the React dashboard (reads Supabase + Realtime)
```

## One-time setup

### 1. Discord bot (read-only)
1. https://discord.com/developers/applications → **New Application** → *Bot* tab → **Reset Token** (copy it).
2. Same page: turn on **Message Content Intent**.
3. *OAuth2 → URL Generator*: scope `bot`, permissions **View Channels** + **Read Message History** → open the URL, add it to your server.
4. In Discord (Developer Mode on) right-click the SDLink channel → **Copy Channel ID**.
5. Put the channel ID in `wrangler.jsonc` → `DISCORD_CHANNEL_ID`.

Optional hardening: right-click the SDLink bot/webhook message → Copy ID of the author, and put it in
`SOURCE_AUTHOR_IDS` so players can't fake "X has joined the server!" in chat.

### 2. GitHub + Cloudflare (same as the US Pizza repos)
1. Create an empty GitHub repo (e.g. `Mip-s/minecraft-monitor`) and push this folder:
   ```
   git remote add origin https://github.com/Mip-s/minecraft-monitor.git
   git push -u origin main
   ```
2. Cloudflare dashboard → Workers & Pages → **Create** → *Import a repository* → pick the repo.
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
3. After the first deploy: Worker → **Settings → Variables and Secrets** → add three **Secrets**:
   | Name | Value |
   |---|---|
   | `DISCORD_BOT_TOKEN` | bot token from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → minecraft-monitor → Project Settings → API Keys → `service_role` (or a `sb_secret_…` key) |
   | `VAPID_PRIVATE_KEY` | the value in `.dev.vars` (this folder, not committed) |

The cron (every minute, 2 checks per minute) starts by itself. The very first run backfills the last
100 channel messages silently; alerts start from then on.

### 3. Phone alerts
Open the dashboard → **Enable alerts** → you'll get a "Alerts are on" test notification.
iPhone: Safari → Share → **Add to Home Screen** first, open it from the Home Screen, then Enable alerts.

## Checking it works
- The dot under the title shows "Checked X ago". Amber = cron hasn't run for 3+ min; red = error (hover for details).
- `GET /api/status` shows `lastPollAt` / `lastError`.
- Cloudflare → Worker → Logs shows each cron run.

## Local dev
```
npm install
npx wrangler dev      # worker + API on :8787 (uses .dev.vars)
npm run dev           # dashboard on :5173, proxies /api to :8787
npm test              # parser tests
```
