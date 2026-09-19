// Receivers turn a platform's webhook / log-drain payload into Event[].
// Each one is a pure function of (body, headers) so it is trivial to test and
// to add: copy one, map the fields, register it in RECEIVERS.
import { levelOf, tsOf, uid, type Event } from "@jevtail/core";

export type Receiver = (body: unknown, headers: Headers, tenant: string) => Event[];

const str = (v: unknown, max = 2000) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)).slice(0, max);

/** Anything: {events:[...]}, [...], one object, or NDJSON text. Fields: message|msg|text, level, ts|timestamp|time, source, link|url. */
export const generic: Receiver = (body, _h, tenant) => {
  const items: any[] = Array.isArray(body) ? body : (body as any)?.events ?? (typeof body === "string" ? body.split("\n").filter(Boolean).map(parseLoose) : [body]);
  return items.filter(Boolean).map((x) => typeof x === "string" ? { message: x } : x).map((x) => ({
    id: uid(), tenant, source: str(x.source ?? "generic", 40) || "generic", ts: tsOf(x.ts ?? x.timestamp ?? x.time),
    level: levelOf(x.level ?? x.severity), message: str(x.message ?? x.msg ?? x.text ?? x), link: x.link ?? x.url,
    meta: pick(x, ["service", "host", "path", "status", "statusCode", "requestId", "deploymentId", "projectName"]),
  }));
};

/**
 * Sentry issue-alert and internal-integration webhooks. Reads `data.event` (integrations),
 * legacy top-level `event`, and `data.issue` for counts. Tags may be [[k,v],...] or an object.
 */
export const sentry: Receiver = (body, _h, tenant) => {
  const b = body as any;
  const issue = b?.data?.issue ?? b?.issue;
  const e = b?.data?.event ?? b?.event ?? issue ?? b;
  if (!e) return [];
  // issue lifecycle webhooks: only new / reopened issues are failures; resolved, ignored, assigned are bookkeeping
  if (b?.action && !["created", "unresolved", "triggered", "reappeared", "regressed"].includes(String(b.action))) return [];
  const tags: Record<string, string> = Array.isArray(e.tags) ? Object.fromEntries(e.tags.map((t: any) => Array.isArray(t) ? t : [t?.key, t?.value])) : (e.tags ?? {});
  const exc = e.exception?.values?.[0];
  const title = str(e.title ?? issue?.title ?? e.message ?? e.logentry?.formatted ?? (exc ? `${exc.type}: ${exc.value}` : "sentry event"));
  const culprit = e.culprit ?? issue?.culprit ?? tags.transaction;
  const message = culprit && !title.includes(culprit) ? `${title} (at ${culprit})` : title;
  const link = e.web_url ?? issue?.web_url ?? issue?.permalink ?? b?.url;
  return [{
    id: String(e.event_id ?? e.id ?? uid()), tenant, source: "sentry",
    ts: tsOf(e.datetime ?? e.timestamp ?? issue?.lastSeen), level: levelOf(e.level ?? tags.level ?? issue?.level ?? b?.level, "error"),
    message, link,
    meta: pick({
      project: b?.project ?? issue?.project?.slug ?? b?.data?.issue?.project?.slug, environment: e.environment ?? tags.environment, release: e.release ?? tags.release,
      action: b?.action, issue: issue?.shortId, issue_category: issue?.issueCategory ?? issue?.category, issue_type: issue?.issueType ?? issue?.type,
      events: num(issue?.count), users: num(issue?.userCount), url: tags.url, handled: tags.handled, mechanism: tags.mechanism,
      exception: str(exc?.value ?? exc?.type, 300) || undefined, platform: e.platform ?? issue?.platform,
    }, ["project", "environment", "release", "action", "issue", "issue_category", "issue_type", "events", "users", "url", "handled", "mechanism", "exception", "platform"]),
  }];
};
const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

/** Vercel Log Drain (json or ndjson format). Level from `level`, else 5xx -> error, 4xx -> warn. */
export const vercel: Receiver = (body, _h, tenant) => {
  const items: any[] = Array.isArray(body) ? body : typeof body === "string" ? body.split("\n").filter(Boolean).map(parseLoose) : [body];
  return items.filter((x) => x && typeof x === "object").map((x) => {
    const status = Number(x.statusCode ?? x.proxy?.statusCode);
    const level = x.level ? levelOf(x.level) : status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    return {
      id: String(x.id ?? uid()), tenant, source: "vercel", ts: tsOf(x.timestamp), level,
      message: str(x.message ?? `${x.proxy?.method ?? ""} ${x.path ?? x.proxy?.path ?? ""} ${status || ""}`.trim()),
      link: x.deploymentId ? `https://vercel.com/${x.projectName ?? ""}/deployments/${x.deploymentId}` : undefined,
      meta: pick(x, ["source", "projectName", "deploymentId", "host", "path", "statusCode", "requestId", "environment", "branch"]),
    };
  });
};

/**
 * Supabase logs: the HTTP Log Drain, the Management/MCP unified `logs` rows, and Logflare-style
 * batches all reduce to {timestamp, source?, event_message, log_attributes | metadata}.
 * Attributes may be nested or dot-flattened ("parsed.error_severity"); both are read.
 */
export const supabase: Receiver = (body, _h, tenant) => {
  const b = body as any;
  const items: any[] = Array.isArray(b) ? b : b?.logs ?? b?.result ?? b?.events ?? [b];
  return items.filter((x) => x && typeof x === "object").map((x) => {
    let a: any = x.log_attributes ?? x.metadata ?? {};
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
    const get = (k: string) => a[k] ?? k.split(".").reduce((o: any, p) => o?.[p], a);
    const stream = String(x.source ?? get("source") ?? "").replace(/_logs$/, "");
    let message = str(x.event_message ?? x.message ?? x);
    let parsed: any = null;
    if (message.startsWith("{")) { try { parsed = JSON.parse(message); } catch { /* not json */ } }
    if (parsed?.msg) message = [parsed.msg, parsed.method, parsed.path, parsed.error].filter(Boolean).join(" ");
    const edge = /^(\w+) \| (\d{3}) \| (\S+)/.exec(message);              // edge_logs: "GET | 500 | https://... | node"
    const status = Number(get("response.status_code") ?? get("status_code") ?? edge?.[2] ?? parsed?.status);
    const rawLevel = get("level") ?? get("parsed.error_severity") ?? parsed?.level;
    const level = rawLevel ? levelOf(rawLevel) : status >= 500 ? "error" : status >= 400 ? "warn"
      : /error|fatal|panic|exception|killed|timeout/i.test(message) ? "error" : "info";
    return {
      id: String(x.id ?? uid()), tenant, source: stream ? `supabase:${stream}` : "supabase", ts: tsOf(x.timestamp), level, message,
      meta: pick({ project: get("project") ?? x.project, component: get("component") ?? parsed?.component, host: get("host"),
        method: get("method") ?? parsed?.method ?? edge?.[1], path: get("path") ?? parsed?.path ?? (edge?.[3] ? safePath(edge[3]) : undefined),
        status: Number.isFinite(status) ? status : undefined, sql_state: get("parsed.sql_state_code") }, ["project", "component", "host", "method", "path", "status", "sql_state"]),
    };
  });
};
function safePath(u: string) { try { return new URL(u).pathname; } catch { return u; } }

export const RECEIVERS: Record<string, Receiver> = { generic, sentry, vercel, supabase };

function parseLoose(line: string) { try { return JSON.parse(line); } catch { return { message: line }; } }
function pick(o: any, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o?.[k] != null) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
}
