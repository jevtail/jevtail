# Files and containers on your own machine

No credentials, no public URL. The Bun runtime follows files and containers directly and
feeds them into the same pipeline as the webhooks.

```
JEVTAIL_TAIL="api=/srv/api/logs/server.log,web=/srv/web/out.log|/srv/web/err.log"
JEVTAIL_DOCKER="backend,worker,scheduler"
JEVTAIL_DOCKER_BIN=/usr/local/bin/docker     # OrbStack / Docker Desktop path when launchd's PATH is bare
```

- `name=path` per service; several files for one service with `|`. **Quote the whole value**
  when the env file is sourced by a shell (`|` becomes a pipe otherwise).
- Container names as in `docker ps`; the source becomes `docker:<name>`.
- JSON lines keep their `level` / `message` / `ts`; plain lines are classified by keyword
  (FATAL, ERROR, Traceback, WARN).
- Lines are batched every 3 s. A process that exits is restarted after 5 s.

What to include: application services. What to skip: nginx access logs, databases, redis,
CDN edge logs. Those lines carry no level, mask down to one template per route, and would
only cost tokens.

macOS launchd install is in [deploy/README.md](../../deploy/README.md).
