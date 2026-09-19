# Supabase

Two ways in. Pick by plan.

| | Log Drain (push) | Management API poll (pull) |
| --- | --- | --- |
| Plan | Pro and above | Free works |
| Setup | Project Settings → Log Drains → HTTP endpoint → jevtail URL | one personal access token in jevtail's env |
| Latency | seconds | `SUPABASE_POLL_SEC` (default 60) |
| What arrives | everything | only judge-worthy rows (see below) |

## Pull (free tier)

1. https://supabase.com/dashboard/account/tokens → **Generate new token**. If you get the
   fine-grained editor, pick the projects and tick only **Analytics → Logs → Read**
   (`analytics_logs_read`); everything else off.
2. In jevtail's env:

```
SUPABASE_ACCESS_TOKEN=sbp_...
SUPABASE_PROJECTS=<ref1>,<ref2>       # Project Settings → General → Reference ID
SUPABASE_POLL_SEC=60
```

The poller queries `GET /v1/projects/{ref}/analytics/endpoints/logs` with ClickHouse SQL over
the unified `logs` table and pulls only: postgres rows whose `parsed.error_severity` is not
LOG/INFO/DEBUG/NOTICE, edge requests with status ≥ 400, auth/postgrest/storage/function rows
with a warn-or-worse level, and postgrest messages containing "error". Everything else is
noise that would only cost tokens.

## Push (Log Drain, Pro)

Project Settings → Log Drains → Add → HTTP endpoint → `https://<host>/in/supabase?token=…`.
The receiver accepts both the drain's `{timestamp, event_message, metadata}` rows and the
Management API's `{timestamp, source, event_message, log_attributes}` rows.

## Shape notes (learned from real projects)

- `log_attributes` is **dot-flattened** (`parsed.error_severity`, `response.status_code`); the
  receiver reads both flattened and nested keys.
- Timestamps come **without a timezone** (`2026-09-19T05:32:24.503132`) and are UTC; parsing
  them as local time shifts everything by your offset. The receiver appends `Z`.
- `auth_logs` messages are JSON strings; the receiver unwraps `msg`, `method`, `path`, `error`.
- Sources become `supabase:postgrest`, `supabase:edge`, `supabase:auth`, `supabase:postgres`,
  `supabase:supavisor` so alerts say which component spoke.
- The one recurring row on idle projects is PostgREST's "Warp server error: Thread killed by
  timeout manager"; Jev scores it minor/timeout, below the alert line, which is correct.
