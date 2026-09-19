# Deploying jevtail

Same code, three shapes. Pick the one that matches where your logs already are.

| Shape | When | How |
| --- | --- | --- |
| **Cloudflare Workers** | Everything is on Vercel / Sentry / Supabase and you have no server | `wrangler d1 create jevtail`, secrets, `bun run worker:deploy` |
| **Docker** | You have a box with Docker (or a PaaS that runs a container) | `docker compose -f deploy/docker-compose.yml up -d` |
| **launchd on macOS** | A Mac mini already runs your services and you want to tail their logs directly | below |

Receivers need a public URL only for push sources (Sentry webhooks, Vercel / Supabase drains).
Pull sources (`JEVTAIL_TAIL`, `JEVTAIL_DOCKER`, the Supabase poller) work without one.

## macOS (launchd) self-host

```bash
curl -fsSL https://bun.sh/install | bash
mkdir -p ~/services/jevtail/logs && cd ~/services/jevtail
git clone https://github.com/jevtail/jevtail app && (cd app && bun install --frozen-lockfile)
cat > .env <<'ENV'
TYPESAFE_API_KEY=...
JEVTAIL_TOKEN=$(openssl rand -hex 16)
PORT=8787
JEVTAIL_DB=/Users/you/services/jevtail/jevtail.db
# tail your launchd services' log files (name=path, several paths with |)  -- quote the value
JEVTAIL_TAIL="api=/Users/you/services/api/logs/server.log,web=/Users/you/services/web/logs/out.log|/Users/you/services/web/logs/err.log"
# follow containers by name (OrbStack / Docker Desktop)
JEVTAIL_DOCKER="backend,scheduler"
JEVTAIL_DOCKER_BIN=/usr/local/bin/docker
# free-tier Supabase: poll the Management API instead of a (Pro-only) log drain
SUPABASE_ACCESS_TOKEN=sbp_...
SUPABASE_PROJECTS=ref1,ref2
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ENV
sed "s/CHANGE_ME/$(whoami)/g" app/deploy/launchd/com.jevtail.server.plist > ~/Library/LaunchAgents/com.jevtail.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jevtail.server.plist
curl localhost:8787/health
```

Update: `cd ~/services/jevtail/app && git pull && bun install && launchctl kickstart -k gui/$(id -u)/com.jevtail.server`.

### Public URL through an existing Cloudflare Tunnel

If the machine already runs `cloudflared tunnel run --token …` (dashboard-managed), add a public
hostname in Zero Trust → Networks → Tunnels → your tunnel → Public Hostname:
`jevtail.example.com` → `http://localhost:8787`. Then paste
`https://jevtail.example.com/in/sentry?token=<JEVTAIL_TOKEN>` into Sentry, and the Vercel /
Supabase equivalents into their drain settings.

## Pull sources (Bun runtime only)

| Env | What it does |
| --- | --- |
| `JEVTAIL_TAIL="name=/path/a.log\|/path/b.log,…"` | `tail -F` each file; JSON lines keep their level, plain lines are classified by keyword (ERROR, WARN, Traceback, FATAL) |
| `JEVTAIL_DOCKER="c1,c2"` | `docker logs -f` each container; source becomes `docker:c1` |
| `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECTS` | every `SUPABASE_POLL_SEC` (60) pulls only judge-worthy rows: postgres errors, 4xx/5xx edge requests, non-info auth/postgrest/storage/function logs |

Lines are batched every 3 s, deduplicated into templates, and go through the same rules,
store and sinks as the HTTP receivers. Skip nginx access logs and databases: their lines
carry no level and would only cost tokens.
