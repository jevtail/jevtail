// ingest: events -> template keys -> judge only novel/stale templates with Jev
// -> persist -> return the events that deserve an alert.
import type { Event, JudgedEvent, Judgment } from "./event";
import { templateKey } from "./template";
import { flat, type JevClient, type Rules } from "./jev";
import type { Store } from "./store";

export interface PipelineConfig {
  rules: Rules;
  /** re-judge a template after this long (ms); its shape may mean something new now */
  rejudgeAfterMs: number;
  /** alert at most once per template per this long (ms) */
  alertCooldownMs: number;
  /** decide whether a judged event should alert; default: needs_human >= 0.7 or severity >= 2 */
  shouldAlert: (j: Record<string, number | string>) => boolean;
}

export const defaultShouldAlert: PipelineConfig["shouldAlert"] = (j) =>
  (typeof j.needs_human === "number" && j.needs_human >= 0.7) || (typeof j.severity === "number" && j.severity >= 2);

export interface IngestResult { received: number; judged: number; tokens: number; alerts: JudgedEvent[] }

// ponytail: one in-process queue per tenant so two webhooks for the same template cannot
// both see "new template" and alert twice. Move to a DB-level lock for multi-instance deploys.
const queues = new Map<string, Promise<unknown>>();
export function ingest(events: Event[], deps: { store: Store; jev: JevClient; config: PipelineConfig }): Promise<IngestResult> {
  const tenant = events[0]?.tenant ?? "default";
  const prev = queues.get(tenant) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => ingestUnlocked(events, deps));
  queues.set(tenant, run);
  return run;
}

async function ingestUnlocked(events: Event[], deps: { store: Store; jev: JevClient; config: PipelineConfig }): Promise<IngestResult> {
  const { store, jev, config } = deps;
  if (!events.length) return { received: 0, judged: 0, tokens: 0, alerts: [] };
  const now = Date.now();

  // 1. template per event; one representative per template
  const keyed = await Promise.all(events.map(async (e) => ({ e, ...(await templateKey(e.source, e.level, e.message)) })));
  const byKey = new Map<string, { masked: string; sample: Event; n: number; last: number; first: number }>();
  for (const { e, key, masked } of keyed) {
    const t = byKey.get(key);
    if (t) { t.n++; t.last = Math.max(t.last, e.ts); t.first = Math.min(t.first, e.ts); }
    else byKey.set(key, { masked, sample: e, n: 1, last: e.ts, first: e.ts });
  }

  // 2. which templates need a judgment
  const tenant = events[0].tenant;
  const keys = [...byKey.keys()];
  const existing = new Map<string, { judgment: string | null; judged_ts: number | null; alerted_ts: number | null }>();
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const rows = await store.all<{ key: string; judgment: string | null; judged_ts: number | null; alerted_ts: number | null }>(
      `SELECT key, judgment, judged_ts, alerted_ts FROM templates WHERE tenant = ? AND key IN (${slice.map(() => "?").join(",")})`, [tenant, ...slice]);
    for (const r of rows) existing.set(r.key, r);
  }
  const toJudge = keys.filter((k) => { const x = existing.get(k); return !x?.judgment || !x.judged_ts || now - x.judged_ts > config.rejudgeAfterMs; });

  // 3. judge representatives
  let tokens = 0;
  const judgments = new Map<string, Judgment>();
  for (const k of keys) { const x = existing.get(k); if (x?.judgment) judgments.set(k, JSON.parse(x.judgment)); }
  if (toJudge.length) {
    const r = await jev.judge(toJudge.map((k) => byKey.get(k)!.sample), config.rules);
    tokens = r.tokens;
    toJudge.forEach((k, i) => judgments.set(k, r.judgments[i]));
  }

  // 4. persist templates and events
  for (const k of keys) {
    const t = byKey.get(k)!;
    const j = judgments.get(k);
    const judgedNow = toJudge.includes(k);
    await store.exec(
      `INSERT INTO templates (tenant, key, source, level, masked, count, first_ts, last_ts, judgment, judged_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant, key) DO UPDATE SET count = count + excluded.count, last_ts = MAX(last_ts, excluded.last_ts),
         judgment = COALESCE(excluded.judgment, judgment), judged_ts = COALESCE(excluded.judged_ts, judged_ts)`,
      [tenant, k, t.sample.source, t.sample.level, t.masked, t.n, t.first, t.last, judgedNow && j ? JSON.stringify(j) : null, judgedNow ? now : null]);
  }
  const out: JudgedEvent[] = keyed.map(({ e, key }) => ({ ...e, template: key, judgment: judgments.get(key), novel: !existing.has(key) }));
  for (const e of out) {
    await store.exec(`INSERT OR IGNORE INTO events (id, tenant, source, ts, level, message, meta, link, template, judgment) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [e.id, e.tenant, e.source, e.ts, e.level, e.message, e.meta ? JSON.stringify(e.meta) : null, e.link ?? null, e.template, e.judgment ? JSON.stringify(e.judgment) : null]);
  }

  // 5. alerts: one per template, respecting cooldown
  const alerts: JudgedEvent[] = [];
  for (const k of keys) {
    const j = judgments.get(k);
    if (!j || !config.shouldAlert(flat(j))) continue;
    const last = existing.get(k)?.alerted_ts ?? 0;
    if (now - last < config.alertCooldownMs) continue;
    const t = byKey.get(k)!;
    alerts.push({ ...t.sample, template: k, judgment: j, novel: !existing.has(k), meta: { ...(t.sample.meta ?? {}), occurrences: t.n } });
    await store.exec(`UPDATE templates SET alerted_ts = ? WHERE tenant = ? AND key = ?`, [now, tenant, k]);
  }
  return { received: events.length, judged: toJudge.length, tokens, alerts };
}
