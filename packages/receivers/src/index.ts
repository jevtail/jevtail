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

/** Sentry issue-alert / internal-integration webhooks. Takes both `data.event` (integrations) and legacy top-level `event`. */
export const sentry: Receiver = (body, _h, tenant) => {
  const b = body as any;
  const e = b?.data?.event ?? b?.event ?? b?.data?.issue ?? b;
  if (!e) return [];
  const message = str(e.title ?? e.message ?? e.logentry?.formatted ?? e.culprit ?? "sentry event");
  const link = e.web_url ?? b?.data?.issue?.web_url ?? b?.url;
  return [{
    id: uid(), tenant, source: "sentry", ts: tsOf(e.datetime ?? e.timestamp ?? b?.data?.issue?.lastSeen), level: levelOf(e.level ?? b?.level, "error"),
    message, link,
    meta: { project: b?.project ?? b?.data?.issue?.project?.slug, environment: e.environment, release: e.release, action: b?.action, culprit: e.culprit,
      exception: str(e.exception?.values?.[0]?.value ?? e.exception?.values?.[0]?.type, 300) || undefined },
  }];
};

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

/** Supabase Log Drain (HTTP). Batches of {id, timestamp, event_message, metadata}. ponytail: shape from docs, verify against a real drain. */
export const supabase: Receiver = (body, _h, tenant) => {
  const items: any[] = Array.isArray(body) ? body : (body as any)?.logs ?? [body];
  return items.filter((x) => x && typeof x === "object").map((x) => ({
    id: String(x.id ?? uid()), tenant, source: "supabase", ts: tsOf(x.timestamp),
    level: levelOf(x.metadata?.level ?? x.metadata?.severity ?? x.level, /error|fatal|exception/i.test(String(x.event_message)) ? "error" : "info"),
    message: str(x.event_message ?? x.message ?? x),
    meta: { project: x.metadata?.project ?? x.project, component: x.metadata?.component ?? x.source ?? x.metadata?.host, status: x.metadata?.response?.status_code },
  }));
};

export const RECEIVERS: Record<string, Receiver> = { generic, sentry, vercel, supabase };

function parseLoose(line: string) { try { return JSON.parse(line); } catch { return { message: line }; } }
function pick(o: any, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o?.[k] != null) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
}
