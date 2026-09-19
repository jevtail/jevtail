// Read side, shared by the HTTP API and the MCP tools. Plain SQL over Store.
import { flat } from "./jev";
import type { Store } from "./store";

const parse = (r: Record<string, unknown>) => {
  const out: Record<string, unknown> = { ...r };
  for (const k of ["meta", "judgment"]) if (typeof r[k] === "string") { try { out[k] = JSON.parse(r[k] as string); } catch { /* keep */ } }
  if (out.judgment && typeof out.judgment === "object") out.scores = flat(out.judgment as any);
  return out;
};

export interface EventFilter {
  tenant?: string; since?: number; until?: number; source?: string; level?: string; category?: string;
  minSeverity?: number; minNeedsHuman?: number; text?: string; template?: string; limit?: number;
}

export async function listEvents(store: Store, f: EventFilter = {}) {
  const where: string[] = ["tenant = ?"]; const p: unknown[] = [f.tenant ?? "default"];
  if (f.since != null) { where.push("ts >= ?"); p.push(f.since); }
  if (f.until != null) { where.push("ts <= ?"); p.push(f.until); }
  if (f.source) { where.push("source LIKE ?"); p.push(f.source.includes("%") ? f.source : `${f.source}%`); }
  if (f.level) { where.push("level = ?"); p.push(f.level); }
  if (f.template) { where.push("template = ?"); p.push(f.template); }
  if (f.category) { where.push("json_extract(judgment, '$.category.choice') = ?"); p.push(f.category); }
  if (f.minSeverity != null) { where.push("json_extract(judgment, '$.severity.score') >= ?"); p.push(f.minSeverity); }
  if (f.minNeedsHuman != null) { where.push("json_extract(judgment, '$.needs_human.noul') >= ?"); p.push(f.minNeedsHuman); }
  if (f.text) { where.push("message LIKE ?"); p.push(`%${f.text}%`); }
  p.push(Math.min(500, f.limit ?? 100));
  const rows = await store.all(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`, p);
  return rows.map(parse);
}

/** Events that crossed the alert line, one per template (the sample that alerted). */
export async function listAlerts(store: Store, o: { tenant?: string; since?: number; limit?: number } = {}) {
  const rows = await store.all(
    `SELECT t.key AS template, t.source, t.level, t.count, t.first_ts, t.last_ts, t.alerted_ts, t.masked, t.judgment,
            (SELECT message FROM events e WHERE e.tenant = t.tenant AND e.template = t.key ORDER BY e.ts DESC LIMIT 1) AS message,
            (SELECT link FROM events e WHERE e.tenant = t.tenant AND e.template = t.key AND e.link IS NOT NULL ORDER BY e.ts DESC LIMIT 1) AS link
     FROM templates t WHERE t.tenant = ? AND t.alerted_ts IS NOT NULL AND t.alerted_ts >= ? ORDER BY t.alerted_ts DESC LIMIT ?`,
    [o.tenant ?? "default", o.since ?? 0, Math.min(200, o.limit ?? 50)]);
  return rows.map(parse);
}

export async function listTemplates(store: Store, o: { tenant?: string; since?: number; source?: string; minSeverity?: number; orderBy?: "count" | "last_ts" | "severity"; limit?: number } = {}) {
  const where = ["tenant = ?"]; const p: unknown[] = [o.tenant ?? "default"];
  if (o.since != null) { where.push("last_ts >= ?"); p.push(o.since); }
  if (o.source) { where.push("source LIKE ?"); p.push(`${o.source}%`); }
  if (o.minSeverity != null) { where.push("json_extract(judgment, '$.severity.score') >= ?"); p.push(o.minSeverity); }
  const order = o.orderBy === "severity" ? "json_extract(judgment, '$.severity.score') DESC" : o.orderBy === "count" ? "count DESC" : "last_ts DESC";
  p.push(Math.min(500, o.limit ?? 100));
  const rows = await store.all(`SELECT * FROM templates WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`, p);
  return rows.map(parse);
}

export async function getTemplate(store: Store, key: string, o: { tenant?: string; samples?: number } = {}) {
  const [t] = (await store.all(`SELECT * FROM templates WHERE tenant = ? AND key = ?`, [o.tenant ?? "default", key])).map(parse);
  if (!t) return null;
  const samples = await listEvents(store, { tenant: o.tenant, template: key, limit: o.samples ?? 5 });
  return { ...t, samples };
}

/** Situational summary for a window: totals, by source, by category, by severity band, and the top templates. */
export async function stats(store: Store, o: { tenant?: string; since: number } = { since: Date.now() - 3_600_000 }) {
  const tenant = o.tenant ?? "default";
  const [tot] = await store.all<{ events: number; templates: number; errors: number }>(
    `SELECT COUNT(*) AS events, COUNT(DISTINCT template) AS templates, SUM(CASE WHEN level IN ('error','fatal') THEN 1 ELSE 0 END) AS errors FROM events WHERE tenant = ? AND ts >= ?`, [tenant, o.since]);
  const bySource = await store.all(`SELECT source, COUNT(*) AS n FROM events WHERE tenant = ? AND ts >= ? GROUP BY source ORDER BY n DESC`, [tenant, o.since]);
  const byCategory = await store.all(`SELECT json_extract(judgment,'$.category.choice') AS category, COUNT(*) AS n FROM events WHERE tenant = ? AND ts >= ? AND judgment IS NOT NULL GROUP BY category ORDER BY n DESC`, [tenant, o.since]);
  const bySeverity = await store.all(
    `SELECT CASE WHEN s >= 2.5 THEN 'critical' WHEN s >= 1.5 THEN 'major' WHEN s >= 0.5 THEN 'minor' ELSE 'noise' END AS band, COUNT(*) AS n
     FROM (SELECT json_extract(judgment,'$.severity.score') AS s FROM events WHERE tenant = ? AND ts >= ? AND judgment IS NOT NULL) GROUP BY band ORDER BY n DESC`, [tenant, o.since]);
  const alerts = await listAlerts(store, { tenant, since: o.since, limit: 20 });
  const top = await listTemplates(store, { tenant, since: o.since, orderBy: "severity", limit: 10 });
  return { since: o.since, ...tot, bySource, byCategory, bySeverity, alerts: alerts.length, recentAlerts: alerts.slice(0, 5), worstTemplates: top.map((t) => ({ key: t.key, source: t.source, count: t.count, masked: t.masked, scores: t.scores })) };
}
