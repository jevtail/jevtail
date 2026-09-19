// MCP over Streamable HTTP, served by the same app at /mcp. Any MCP client
// (Claude Code, Cursor, Strands, LangChain, the SDKs) connects with the URL
// and the jevtail token. Tools are thin wrappers over core queries + ingest.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { listEvents, listAlerts, listTemplates, getTemplate, stats, flat, type Store, type JevClient, type Rules, type Event, type IngestResult } from "@jevtail/core";
import { generic } from "@jevtail/receivers";

export interface McpDeps { store: Store; jev: JevClient; rules: Rules; ingest: (events: Event[]) => Promise<IngestResult>; version?: string }

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const sinceOf = (minutes?: number, since?: number) => since ?? Date.now() - (minutes ?? 60) * 60_000;

export function createMcpServer(d: McpDeps) {
  const server = new McpServer({ name: "jevtail", version: d.version ?? "0.1.0" }, {
    instructions:
      "jevtail watches logs and alerts, collapses them into templates, and has Jev (TypeSafe's System One model) judge each template: " +
      "is_failure (0-1), needs_human (0-1), severity (0 noise, 1 minor, 2 major, 3 critical), category (timeout, dependency, auth, resource, bug, deploy, security, other), security (0-1). " +
      "Start with jevtail_stats for the situation, jevtail_alerts for what crossed the line, jevtail_events / jevtail_template to drill in, jevtail_judge to score text you found elsewhere.",
  });

  server.registerTool("jevtail_stats", {
    description: "Situational summary for a time window: counts by source, category and severity band, recent alerts, worst templates. Call this first.",
    inputSchema: { minutes: z.number().int().positive().max(10080).default(60).describe("window length ending now") },
  }, async ({ minutes }) => json(await stats(d.store, { since: sinceOf(minutes) })));

  server.registerTool("jevtail_alerts", {
    description: "Templates that crossed the alert line (needs_human >= 0.7 or severity >= 2), newest first, with the latest sample message and link.",
    inputSchema: { minutes: z.number().int().positive().max(10080).default(1440), limit: z.number().int().positive().max(200).default(50) },
  }, async ({ minutes, limit }) => json(await listAlerts(d.store, { since: sinceOf(minutes), limit })));

  server.registerTool("jevtail_events", {
    description: "Judged events, newest first. Filter by source prefix (e.g. 'docker:', 'supabase:', 'sentry'), level, Jev category, minimum severity / needs_human, or a text substring.",
    inputSchema: {
      minutes: z.number().int().positive().max(10080).default(60),
      source: z.string().optional(), level: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
      category: z.enum(["timeout", "dependency", "auth", "resource", "bug", "deploy", "security", "other"]).optional(),
      min_severity: z.number().min(0).max(3).optional(), min_needs_human: z.number().min(0).max(1).optional(),
      text: z.string().optional(), limit: z.number().int().positive().max(500).default(50),
    },
  }, async (a) => json(await listEvents(d.store, { since: sinceOf(a.minutes), source: a.source, level: a.level, category: a.category, minSeverity: a.min_severity, minNeedsHuman: a.min_needs_human, text: a.text, limit: a.limit })));

  server.registerTool("jevtail_templates", {
    description: "Log templates (lines that differ only in variables) with counts, first/last seen and Jev scores. Order by count, last_ts or severity.",
    inputSchema: { minutes: z.number().int().positive().max(10080).default(1440), source: z.string().optional(), min_severity: z.number().min(0).max(3).optional(), order_by: z.enum(["count", "last_ts", "severity"]).default("severity"), limit: z.number().int().positive().max(500).default(50) },
  }, async (a) => json(await listTemplates(d.store, { since: sinceOf(a.minutes), source: a.source, minSeverity: a.min_severity, orderBy: a.order_by, limit: a.limit })));

  server.registerTool("jevtail_template", {
    description: "One template with its judgment and the most recent sample events (full messages, meta, links).",
    inputSchema: { key: z.string().describe("template key from jevtail_templates / jevtail_alerts"), samples: z.number().int().positive().max(50).default(5) },
  }, async ({ key, samples }) => json((await getTemplate(d.store, key, { samples })) ?? { error: "no such template" }));

  server.registerTool("jevtail_judge", {
    description: "Run the Jev rules on text you have in hand (log lines, an alert body, a stack trace) without storing it. Returns typed scores per line. Costs a fraction of a cent.",
    inputSchema: { lines: z.array(z.string().min(1)).min(1).max(64), source: z.string().default("adhoc") },
  }, async ({ lines, source }) => {
    const events = generic(lines.map((l) => ({ message: l, source })), new Headers(), "adhoc");
    const r = await d.jev.judge(events, d.rules);
    return json(events.map((e, i) => ({ message: e.message, level: e.level, scores: flat(r.judgments[i]), judgment: r.judgments[i] })));
  });

  server.registerTool("jevtail_ingest", {
    description: "Push events into jevtail (same as POST /in/generic): they are templated, judged, stored, and alerted on. Use for logs an agent fetched from somewhere jevtail is not wired to.",
    inputSchema: { events: z.array(z.object({ message: z.string().min(1), level: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(), source: z.string().optional(), ts: z.union([z.number(), z.string()]).optional(), link: z.string().optional() })).min(1).max(500) },
  }, async ({ events }) => {
    const r = await d.ingest(generic(events, new Headers(), "default"));
    return json({ received: r.received, judged: r.judged, alerts: r.alerts.map((a) => ({ message: a.message, scores: flat(a.judgment ?? {}) })), tokens: r.tokens });
  });

  return server;
}

/** Hono handler for /mcp. One transport per process; the SDK multiplexes sessions. */
export function mcpHandler(d: McpDeps) {
  const server = createMcpServer(d);
  const transport = new StreamableHTTPTransport();
  return async (c: any) => {
    if (!server.isConnected()) await server.connect(transport);
    return transport.handleRequest(c);
  };
}
