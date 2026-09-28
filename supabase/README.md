The database lives in the Supabase project **minecraft-monitor** (ref `cpqwcygfafnuszgdpqnx`, Singapore).
Migrations applied: `init_monitor`, `events_unique_nulls` (see Supabase dashboard → Database → Migrations).

Tables (public schema, RLS on):
- players            – one row per player: online flag, online_since, join_count, total_seconds (public read)
- sessions           – each join→leave session with duration (public read)
- events             – every parsed Discord line; unique per Discord message (public read)
- daily_peak         – peak concurrent players per MYT day (public read)
- push_subscriptions – browsers that turned on alerts (Worker only)
- monitor_state      – last_message_id / last_poll_at / last_error (Worker only)
- today_stats (view) – online_now, unique_today, peak_today, playtime_today_seconds, total_players

Function `record_event(msg_id, user, kind, at)` does all the bookkeeping and is idempotent
(only the service role can call it). A join while a player is already "online" closes the old
session first (missed leave); "Server has stopped" / "Server has started" closes every open session.
