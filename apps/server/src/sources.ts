// Pull-style sources for the Bun runtime: tail local log files, follow docker
// containers, and poll Supabase's Management logs API. Each batches lines and
// hands them to the same ingest() the HTTP receivers use.
import { spawn } from "node:child_process";
import { levelOf, tsOf, uid, type Event } from "@jevtail/core";
import { supabase as supabaseReceiver } from "@jevtail/receivers";

export type Ingest = (events: Event[]) => Promise<unknown>;

const guessLevel = (line: string): Event["level"] =>
  /\b(FATAL|PANIC|CRIT)/i.test(line) ? "fatal" : /\b(ERROR|ERR|Exception|Traceback|Unhandled)\b/i.test(line) ? "error" : /\b(WARN|WARNING)\b/i.test(line) ? "warn" : /\b(DEBUG|TRACE)\b/i.test(line) ? "debug" : "info";

/** One line of anything -> Event. JSON lines get their level/message/ts fields; plain lines are classified by keyword. */
export function lineToEvent(source: string, line: string, tenant = "default"): Event | null {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const msg = String(j.message ?? j.msg ?? j.error ?? j.event ?? s).slice(0, 2000);
      return { id: uid(), tenant, source, ts: tsOf(j.ts ?? j.timestamp ?? j.time), level: levelOf(j.level ?? j.severity, guessLevel(msg)), message: msg, meta: j.meta ?? undefined };
    } catch { /* not json */ }
  }
  return { id: uid(), tenant, source, ts: Date.now(), level: guessLevel(s), message: s.slice(0, 2000) };
}

/** Collect lines from a child process's stdout+stderr and flush every `everyMs`. Restarts the process if it exits. */
function follow(name: string, cmd: string[], ingest: Ingest, everyMs: number, onLine: (l: string) => Event | null) {
  let buf: Event[] = [];
  const start = () => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const feed = (chunk: Buffer) => { for (const l of chunk.toString("utf8").split("\n")) { const e = onLine(l); if (e) buf.push(e); } };
    p.stdout.on("data", feed); p.stderr.on("data", feed);
    p.on("exit", (code) => { console.error(`[source ${name}] exited (${code}), restarting in 5s`); setTimeout(start, 5000); });
    p.on("error", (e) => console.error(`[source ${name}] ${e.message}`));
  };
  start();
  setInterval(async () => {
    if (!buf.length) return;
    const batch = buf; buf = [];
    try { await ingest(batch); } catch (e) { console.error(`[source ${name}] ingest failed: ${(e as Error).message}`); }
  }, everyMs);
  console.log(`[source ${name}] following: ${cmd.join(" ")}`);
}

/** JEVTAIL_TAIL="gostop=/path/server.log,jigeum=/path/a.log|/path/b.log" */
export function tailFiles(spec: string, ingest: Ingest, everyMs = 3000) {
  for (const item of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, paths] = item.includes("=") ? item.split("=", 2) : [item.split("/").pop() ?? item, item];
    for (const path of paths.split("|")) follow(name, ["tail", "-n", "0", "-F", path], ingest, everyMs, (l) => lineToEvent(name, l));
  }
}

/** JEVTAIL_DOCKER="kingsick-backend,hudy-backend" (names as in `docker ps`); JEVTAIL_DOCKER_BIN overrides the binary */
export function tailDocker(spec: string, ingest: Ingest, everyMs = 3000, bin = process.env.JEVTAIL_DOCKER_BIN ?? "docker") {
  for (const name of spec.split(",").map((s) => s.trim()).filter(Boolean))
    follow(name, [bin, "logs", "-f", "--since", "1s", name], ingest, everyMs, (l) => lineToEvent(`docker:${name}`, l));
}

/**
 * Supabase Management API poller (works on the free tier, unlike Log Drains).
 * SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECTS="ref1,ref2"; polls every `everyMs` for the window since the last poll.
 * Only rows worth judging are pulled: non-info levels, 4xx/5xx edge requests, and postgres errors.
 */
export function pollSupabase(token: string, projects: string, ingest: Ingest, everyMs = 60_000, f: typeof fetch = fetch) {
  const refs = projects.split(",").map((s) => s.trim()).filter(Boolean);
  let since = new Date(Date.now() - everyMs).toISOString();
  const sql = `select id, timestamp, source, event_message, log_attributes from logs
    where (source = 'postgres_logs' and log_attributes['parsed.error_severity'] not in ('LOG','INFO','DEBUG','NOTICE'))
       or (source = 'edge_logs' and toInt32OrZero(log_attributes['response.status_code']) >= 400)
       or (source in ('auth_logs','postgrest_logs','storage_logs','function_edge_logs','realtime_logs') and lower(coalesce(log_attributes['level'], '')) in ('error','fatal','panic','warn','warning'))
       or (source = 'postgrest_logs' and event_message ilike '%error%')
    order by timestamp desc limit 500`;
  const tick = async () => {
    const end = new Date().toISOString();
    for (const ref of refs) {
      try {
        const q = new URLSearchParams({ sql, iso_timestamp_start: since, iso_timestamp_end: end });
        const res = await f(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs?${q}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) { console.error(`[supabase ${ref}] ${res.status} ${(await res.text()).slice(0, 200)}`); continue; }
        const json = (await res.json()) as { result?: unknown[]; error?: unknown };
        if (json.error) { console.error(`[supabase ${ref}] ${JSON.stringify(json.error).slice(0, 200)}`); continue; }
        const events = supabaseReceiver(json.result ?? [], new Headers(), "default").map((e) => ({ ...e, meta: { ...(e.meta ?? {}), project: ref } }));
        if (events.length) await ingest(events);
      } catch (e) { console.error(`[supabase ${ref}] ${(e as Error).message}`); }
    }
    since = end;
  };
  setInterval(tick, everyMs);
  console.log(`[supabase] polling ${refs.length} project(s) every ${everyMs / 1000}s`);
}
