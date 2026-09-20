// The one HTTP app. Runs unchanged on Bun (Docker) and Cloudflare Workers:
// the runtime entry points only differ in how they build `deps`.
import { Hono } from "hono";
import { ingest, jevClient, validateRules, migrate, defaultShouldAlert, defaultRules, analyze, type Store, type Rules, type Event, type JudgedEvent } from "@jevtail/core";
import { RECEIVERS } from "@jevtail/receivers";
import { sinksFromEnv, type Sink } from "@jevtail/sinks";
import { mcpHandler } from "./mcp";

export interface Env {
  TYPESAFE_API_KEY: string;
  /** shared secret; receivers accept it as ?token=, Authorization: Bearer, or x-jevtail-token */
  JEVTAIL_TOKEN?: string;
  JEVTAIL_RULES?: string;          // JSON string of rules; default rules otherwise
  JEVTAIL_REJUDGE_HOURS?: string;  // default 24
  JEVTAIL_ALERT_COOLDOWN_MIN?: string; // default 60
  VERCEL_VERIFY?: string;          // echoed back as x-vercel-verify while creating a drain
  TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string;
  SLACK_WEBHOOK_URL?: string; DISCORD_WEBHOOK_URL?: string; ALERT_WEBHOOK_URL?: string;
  JEVTAIL_STDOUT?: string;
  JEVTAIL_ANALYZE?: string;        // "0" disables root-cause analysis on alerts
  // Bun-only pull sources (see sources.ts)
  JEVTAIL_TAIL?: string; JEVTAIL_DOCKER?: string; JEVTAIL_DOCKER_BIN?: string;
  SUPABASE_ACCESS_TOKEN?: string; SUPABASE_PROJECTS?: string; SUPABASE_POLL_SEC?: string;
}

export interface Deps { store: Store; env: Env; fetchImpl?: typeof fetch; sinks?: Sink[] }

export function createApp(deps: Deps) {
  const { store, env } = deps;
  const f = deps.fetchImpl ?? fetch;
  const rules: Rules = validateRules(env.JEVTAIL_RULES ? JSON.parse(env.JEVTAIL_RULES) : defaultRules);
  const jev = jevClient(env.TYPESAFE_API_KEY, f);
  const sinks = deps.sinks ?? sinksFromEnv(env as unknown as Record<string, string | undefined>, f);
  const config = {
    rules,
    rejudgeAfterMs: Number(env.JEVTAIL_REJUDGE_HOURS ?? 24) * 3_600_000,
    alertCooldownMs: Number(env.JEVTAIL_ALERT_COOLDOWN_MIN ?? 60) * 60_000,
    shouldAlert: defaultShouldAlert,
  };
  const ready = migrate(store);
  const app = new Hono();

  app.get("/", (c) => c.text("jevtail: POST /in/{generic|sentry|vercel|supabase}?token=...  GET /events  GET /templates  GET /health  MCP at /mcp\n"));
  app.get("/health", async (c) => { await ready; return c.json({ ok: true, rules: Object.keys(rules), sinks: sinks.length }); });

  const auth = (c: any): string | null => {
    if (!env.JEVTAIL_TOKEN) return "default";
    const t = c.req.query("token") ?? c.req.header("x-jevtail-token") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    return t === env.JEVTAIL_TOKEN ? "default" : null; // ponytail: one tenant per token; map tokens -> tenants here for multi-tenant
  };

  /** ingest from non-HTTP sources (tail, docker, pollers) with the same rules, store and sinks */
  const analyzeAlert = async (a: JudgedEvent) => {
    try {
      const an = await analyze(a, { store, apiKey: env.TYPESAFE_API_KEY, fetchImpl: f });
      await store.exec(`INSERT OR REPLACE INTO analyses (tenant, template, ts, analysis) VALUES (?, ?, ?, ?)`, [a.tenant, a.template, Date.now(), JSON.stringify(an)]);
      a.analysis = an;
    } catch (e) { console.error("analyze failed:", (e as Error).message); }
  };
  const ingestEvents = async (events: Event[]) => {
    await ready;
    const r = await ingest(events, { store, jev, config });
    if (r.alerts.length) {
      if (env.JEVTAIL_ANALYZE !== "0") await Promise.all(r.alerts.map(analyzeAlert));
      await Promise.all(sinks.map((s) => s(r.alerts).catch((e) => console.error("sink failed:", e.message))));
    }
    return r;
  };

  app.post("/in/:receiver", async (c) => {
    const tenant = auth(c);
    if (!tenant) return c.json({ error: "bad token" }, 401);
    const recv = RECEIVERS[c.req.param("receiver")];
    if (!recv) return c.json({ error: `unknown receiver; one of ${Object.keys(RECEIVERS).join(", ")}` }, 404);
    if (env.VERCEL_VERIFY) c.header("x-vercel-verify", env.VERCEL_VERIFY);
    const raw = await c.req.text();
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* ndjson or plain text: receivers handle strings */ }
    let events: Event[];
    try { events = recv(body, c.req.raw.headers, tenant); } catch (e) { return c.json({ error: `parse: ${(e as Error).message}` }, 400); }
    const r = await ingestEvents(events);
    return c.json({ received: r.received, judged: r.judged, alerts: r.alerts.length, tokens: r.tokens });
  });

  // MCP (Streamable HTTP) for agents: same token, same data.
  const mcp = mcpHandler({ store, jev, rules, ingest: ingestEvents, analyze: (a) => analyze(a, { store, apiKey: env.TYPESAFE_API_KEY, fetchImpl: f }) });
  app.all("/mcp", async (c) => (auth(c) ? mcp(c) : c.json({ error: "bad token" }, 401)));

  app.get("/events", async (c) => {
    if (!auth(c)) return c.json({ error: "bad token" }, 401);
    await ready;
    const since = Number(c.req.query("since") ?? Date.now() - 3_600_000);
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100));
    const rows = await store.all(`SELECT * FROM events WHERE tenant = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`, ["default", since, limit]);
    return c.json(rows.map(parseRow));
  });

  app.get("/templates", async (c) => {
    if (!auth(c)) return c.json({ error: "bad token" }, 401);
    await ready;
    const rows = await store.all(`SELECT * FROM templates WHERE tenant = ? ORDER BY last_ts DESC LIMIT 200`, ["default"]);
    return c.json(rows.map(parseRow));
  });

  return Object.assign(app, { ingest: ingestEvents });
}

function parseRow(r: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...r };
  for (const k of ["meta", "judgment"]) if (typeof r[k] === "string") { try { out[k] = JSON.parse(r[k] as string); } catch { /* keep */ } }
  return out;
}

export type { JudgedEvent };
