<div align="center">

# jevtail

**Nothing to read. A message only when your app is actually broken, with what kind of problem it is.**

Point your Sentry, Vercel, Supabase, or any log drain at one URL. jevtail collapses
the stream into templates, asks [Jev](https://docs.typesafe.ai) a handful of typed
questions per template, and delivers the few that matter to Telegram, Slack, or Discord.

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![runs on](https://img.shields.io/badge/runs%20on-Docker%20%C2%B7%20Cloudflare%20Workers-0a0)](deploy/)
[![model](https://img.shields.io/badge/powered%20by-Jev%20%C2%B7%20TypeSafe-8a2be2)](https://docs.typesafe.ai)

</div>

---

```
🔴 critical · dependency · sentry · NEW
PrismaClientKnownRequestError: Can't reach database server at db.internal:5432
failure 0.97 · needs_human 0.90 · ×214
api production
https://sentry.io/organizations/acme/issues/9
```

## How it works

```
Sentry / Vercel / Supabase / anything ──POST──▶ /in/<receiver>
                                                   │  normalize to Event
                                                   ▼
                                     template mining (mask ids, numbers, paths)
                                       214 lines ──▶ 1 template ──▶ 1 judgment
                                                   │
                                                   ▼  one Jev request, 5 typed questions
                                   is_failure · needs_human · severity · category · security
                                                   │
                                          SQLite / D1  ──▶  Telegram · Slack · Discord
```

- **Templates, not lines.** Lines that differ only in ids, numbers, paths or timestamps share one
  template. Jev judges one sample per template and the answer is reused for a day, so a
  million lines a day costs cents, not dollars.
- **Typed judgments, not summaries.** Jev returns probabilities and choices, never prose, so
  the alert is assembled from fields: severity, category (timeout, dependency, auth,
  resource, bug, deploy, security), does a human need to look now.
- **One alert per template per hour.** The 215th occurrence does not page you again.
- **Same code everywhere.** One Hono app, SQLite SQL. Bun for Docker, D1 for Workers.

## Run it

### Docker (self-host)

```bash
git clone https://github.com/jevtail/jevtail && cd jevtail
cat > .env <<EOF
TYPESAFE_API_KEY=...        # https://console.typesafe.ai
JEVTAIL_TOKEN=some-secret   # receivers require ?token=
TELEGRAM_BOT_TOKEN=...      # or SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL
TELEGRAM_CHAT_ID=...
EOF
docker compose -f deploy/docker-compose.yml up -d
curl localhost:8787/health
```

### Cloudflare Workers (free tier is plenty)

```bash
bun install
bunx wrangler d1 create jevtail          # paste the id into deploy/wrangler.toml
for s in TYPESAFE_API_KEY JEVTAIL_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  bunx wrangler secret put $s --config deploy/wrangler.toml
done
bun run worker:deploy                     # prints https://jevtail.<you>.workers.dev
```

### macOS server (launchd) and pull sources

Already running services on a Mac mini? Tail their log files and containers directly, no
drains needed, and poll free-tier Supabase through the Management API. See
[deploy/README.md](deploy/README.md).

```bash
JEVTAIL_TAIL="api=/srv/api/logs/server.log" JEVTAIL_DOCKER="backend,worker" \
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECTS=ref1 bun run dev
```

### Local

```bash
TYPESAFE_API_KEY=... bun run dev          # http://localhost:8787
```

## Connect a source

| Source | Where to paste the URL | URL |
| --- | --- | --- |
| Sentry | Alerts → Create Alert → action "Send a notification via webhook", or Settings → Developer Settings → Internal Integration → Webhook URL | `https://<host>/in/sentry?token=<JEVTAIL_TOKEN>` |
| Vercel | Team Settings → Log Drains → Add (format JSON or NDJSON). Set `VERCEL_VERIFY` to the string Vercel shows | `https://<host>/in/vercel?token=<JEVTAIL_TOKEN>` |
| Supabase | Project Settings → Log Drains → HTTP endpoint | `https://<host>/in/supabase?token=<JEVTAIL_TOKEN>` |
| Anything else | POST JSON `{events:[{message, level?, ts?, source?}]}`, an array, or NDJSON | `https://<host>/in/generic?token=<JEVTAIL_TOKEN>` |

```bash
# try it without any platform
curl -X POST "localhost:8787/in/generic?token=some-secret" -H 'content-type: application/json' \
  -d '{"events":[{"message":"Error: connect ECONNREFUSED 10.0.0.5:5432","level":"error","source":"api"}]}'
```

Pipes work too: `kubectl logs -f api | curl -s -X POST --data-binary @- "localhost:8787/in/generic?token=..."`.

## Read it back

```
GET /events?since=<epoch ms>&limit=100&token=...   # judged events, newest first
GET /templates?token=...                            # templates with counts and judgments
GET /health
```

Every event carries its judgment, so `jq '.[] | select(.judgment.category.choice=="dependency")'`
is your incident filter.

## Your own rules

Rules are Jev questions in a JSON object; `JEVTAIL_RULES` overrides the
[default five](packages/core/rules/default.json). Anything Jev accepts works.

```json
{
  "is_failure":  { "type": "noul",  "instructions": "Does this event describe a failure a user would notice?" },
  "needs_human": { "type": "noul",  "instructions": "Should on-call look at this now?" },
  "severity":    { "type": "score", "instructions": "Operational severity.", "criteria": ["noise", "minor", "major", "critical"] },
  "category":    { "type": "choice","instructions": "What kind of failure?", "criteria": { "timeout": "…", "dependency": "…", "auth": "…", "bug": "…", "other": "…" } },
  "billing":     { "type": "noul",  "instructions": "Does this touch payments or invoices?" }
}
```

An alert fires when `needs_human >= 0.7` or `severity >= 2` (major). Tune
`JEVTAIL_REJUDGE_HOURS` and `JEVTAIL_ALERT_COOLDOWN_MIN` in the environment.

## Layout

```
packages/core       Event model, template mining, Jev client, SQLite store (bun:sqlite | D1), pipeline
packages/receivers  sentry · vercel · supabase · generic     (one pure function each)
packages/sinks      telegram · slack/discord webhook · stdout
apps/server         Hono app + Bun entry (+ tail / docker / Supabase pull sources) + Workers entry
deploy/             Dockerfile, docker-compose, wrangler.toml, launchd plist, deploy guide
```

Adding a receiver is one function that maps a payload to `Event[]` and one line in `RECEIVERS`.

## Status

Early, but checked against real data (2026-09-19):

- **Supabase**: 240 unified-log rows from two live projects (edge, supavisor, postgrest, postgres,
  auth) collapsed into 16 templates and 2 Jev requests; the one anomaly (PostgREST
  "Thread killed by timeout manager") was judged minor/timeout, below the alert line, which is right.
- **Sentry**: 10 real unresolved issues rebuilt as issue-alert webhooks; the 45-user TypeError
  scored highest (major/bug), single-user client network errors stayed below the line.
- **Vercel**: parsed against the documented drain shape only.

Jev is in early access. Judgments are probabilities: run in shadow mode (stdout sink) for a
day and read `/templates` before trusting the thresholds on your traffic. Sentry issues are
already grouped, so most new issues clear the line; raise `needs_human` in a custom rule set
if that is too chatty.

## Develop

```bash
bun test            # unit + end-to-end with a fake Jev
bun run typecheck
```

MIT
