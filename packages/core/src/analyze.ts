// Root-cause analysis as a decision graph, with no text generation.
// Code gathers the window, Jev answers typed questions (related? cause? change
// marker? which hypothesis?), code assembles the story from the answers.
import { MODEL, postSystemOne, type Fetch } from "./jev";
import type { JevAnswer } from "./event";
import { listTemplates } from "./queries";
import type { Store } from "./store";
import type { JudgedEvent } from "./event";

export const HYPOTHESES: Record<string, { label: string; steps: string[] }> = {
  deploy:     { label: "recent deploy, restart or config change", steps: ["diff the last deploy / config change", "roll back if the onset matches the change", "check env vars and secrets on the new version"] },
  dependency: { label: "a dependency is down or unreachable (db, cache, queue, upstream)", steps: ["check the dependency's own health and logs", "look for connection limits, auth or DNS between the two", "verify failover / reconnect behaviour"] },
  resource:   { label: "resource exhaustion (memory, disk, connections, file handles, rate limits)", steps: ["check memory / disk / connection pool metrics", "look for a leak: does usage grow with uptime?", "raise the limit only after finding the consumer"] },
  traffic:    { label: "traffic spike or abusive client", steps: ["compare request rate with the previous hour", "check top client IPs / user agents", "rate-limit or block, then scale"] },
  external:   { label: "third-party API failure or degraded provider", steps: ["check the provider's status page", "enable retries / circuit breaker / fallback", "queue and replay if the operation is idempotent"] },
  auth:       { label: "authentication, token or certificate problem", steps: ["check certificate and token expiry dates", "verify rotated keys reached every consumer", "look for clock skew"] },
  data:       { label: "bad or unexpected data (schema drift, null, encoding)", steps: ["find the first failing record", "validate at the boundary and reject early", "backfill or migrate the offending rows"] },
  bug:        { label: "application code bug", steps: ["read the stack trace's first app frame", "reproduce with the failing input", "add a test, fix, deploy"] },
  network:    { label: "network, DNS or infrastructure fault", steps: ["check DNS resolution and routes from the host", "look for packet loss / MTU / firewall changes", "check the cloud provider's incident page"] },
  unknown:    { label: "not enough evidence yet", steps: ["collect the next 10 minutes of logs", "check whether it recurs or self-heals", "add logging around the failing call"] },
};

export interface Candidate { key: string; source: string; level: string; masked: string; count: number; first_ts: number; last_ts: number; scores?: Record<string, unknown> }
export interface Related extends Candidate { related: number; cause: number; change: number }
export interface Analysis {
  hypothesis: string; label: string; confidence: number; probabilities: Record<string, number>;
  self_healing: number; user_impact: number;
  onset_ts: number | null; onset?: Related; change_markers: Related[]; related: Related[];
  steps: string[]; tokens: number; analyzed_at: number;
}

export interface AnalyzeDeps { store: Store; apiKey: string; fetchImpl?: Fetch; windowMs?: number; maxCandidates?: number }

const fmt = (ts: number) => new Date(ts).toISOString().slice(11, 19) + "Z";

/** Candidates: judged templates active in the window around the alert, other than the alert's own template. */
export async function gatherCandidates(store: Store, alert: JudgedEvent, windowMs = 15 * 60_000, max = 20): Promise<Candidate[]> {
  const rows = await listTemplates(store, { tenant: alert.tenant, since: alert.ts - windowMs, limit: 200, orderBy: "last_ts" });
  return rows
    .filter((t: any) => t.key !== alert.template && t.first_ts <= alert.ts + windowMs)
    .map((t: any) => ({ key: t.key, source: t.source, level: t.level, masked: t.masked, count: t.count, first_ts: t.first_ts, last_ts: t.last_ts, scores: t.scores }))
    .sort((a: any, b: any) => (Number(b.scores?.severity ?? 0) - Number(a.scores?.severity ?? 0)) || (b.last_ts - a.last_ts))
    .slice(0, max);
}

export async function analyze(alert: JudgedEvent, d: AnalyzeDeps): Promise<Analysis> {
  const f = d.fetchImpl ?? fetch;
  const candidates = await gatherCandidates(d.store, alert, d.windowMs, d.maxCandidates);
  let tokens = 0;
  const alertState = { source: alert.source, level: alert.level, at: fmt(alert.ts), message: alert.message.slice(0, 600), meta: alert.meta ?? {} };

  // Request 1: relation of every candidate to the alert
  let related: Related[] = [];
  if (candidates.length) {
    const questions: Record<string, unknown> = {};
    candidates.forEach((_, i) => {
      questions[`c${i}.related`] = { type: "noul", instructions: `Look only at candidate c${i}. Is it plausibly part of the same incident as the alert (same failure, same time, same dependency), rather than unrelated background activity?` };
      questions[`c${i}.cause`] = { type: "noul", instructions: `Look only at candidate c${i}. Could it be a CAUSE of the alert (something that would make the alert's failure happen), as opposed to another symptom or unrelated?` };
      questions[`c${i}.change`] = { type: "noul", instructions: `Look only at candidate c${i}. Does it indicate a deploy, restart, scale event, migration or configuration change?` };
    });
    const res = await postSystemOne({ model: MODEL, state: { alert: alertState, candidates: candidates.map((c, i) => ({ id: `c${i}`, source: c.source, level: c.level, first_seen: fmt(c.first_ts), last_seen: fmt(c.last_ts), count: c.count, message: c.masked })) }, questions }, d.apiKey, f);
    tokens += res.usage?.input_tokens ?? 0;
    const n = (a: JevAnswer | undefined) => (typeof a?.noul === "number" ? a.noul : 0);
    related = candidates.map((c, i) => ({ ...c, related: n(res.answers[`c${i}.related`]), cause: n(res.answers[`c${i}.cause`]), change: n(res.answers[`c${i}.change`]) }));
  }
  const strong = related.filter((r) => r.related >= 0.5 || r.cause >= 0.5).sort((a, b) => b.cause - a.cause || b.related - a.related);
  const change_markers = related.filter((r) => r.change >= 0.6 && (r.related >= 0.3 || r.cause >= 0.3)).sort((a, b) => a.first_ts - b.first_ts);
  const onset = [...strong, ...change_markers].sort((a, b) => a.first_ts - b.first_ts)[0];

  // Request 2: hypothesis over the alert plus the strongest evidence
  const evidence = strong.slice(0, 8).map((r) => ({ source: r.source, first_seen: fmt(r.first_ts), count: r.count, message: r.masked, p_cause: r.cause }));
  const res2 = await postSystemOne({
    model: MODEL,
    state: { alert: alertState, evidence, change_markers: change_markers.slice(0, 5).map((r) => ({ source: r.source, at: fmt(r.first_ts), message: r.masked })) },
    questions: {
      hypothesis: { type: "choice", instructions: "Given the alert and the evidence, what is the most likely root cause class? Pick 'unknown' if the evidence does not support any specific class.", criteria: Object.fromEntries(Object.entries(HYPOTHESES).map(([k, v]) => [k, v.label])) },
      self_healing: { type: "noul", instructions: "Is this likely to resolve on its own without intervention (transient timeout, retry succeeded, one-off)?" },
      user_impact: { type: "noul", instructions: "Are end users likely experiencing failures or degraded behaviour right now because of this?" },
    },
  }, d.apiKey, f);
  tokens += res2.usage?.input_tokens ?? 0;
  const h = res2.answers.hypothesis as JevAnswer;
  const hypothesis = h?.choice && HYPOTHESES[h.choice] ? h.choice : "unknown";
  return {
    hypothesis, label: HYPOTHESES[hypothesis].label, confidence: h?.confidence ?? 0, probabilities: h?.probabilities ?? {},
    self_healing: (res2.answers.self_healing as JevAnswer)?.noul ?? 0, user_impact: (res2.answers.user_impact as JevAnswer)?.noul ?? 0,
    onset_ts: onset?.first_ts ?? null, onset, change_markers: change_markers.slice(0, 5), related: strong.slice(0, 8),
    steps: HYPOTHESES[hypothesis].steps, tokens, analyzed_at: Date.now(),
  };
}

/** Human-readable block assembled from typed fields only. */
export function renderAnalysis(a: Analysis, alertTs: number): string[] {
  const lines: string[] = [];
  lines.push(`why (${Math.round(a.confidence * 100)}%): ${a.label}`);
  if (a.onset) lines.push(`onset ${fmt(a.onset.first_ts)} (${Math.round((alertTs - a.onset.first_ts) / 60000)} min before) · ${a.onset.source}: ${a.onset.masked.slice(0, 90)}`);
  for (const m of a.change_markers.slice(0, 2)) if (m.key !== a.onset?.key) lines.push(`change ${fmt(m.first_ts)} · ${m.source}: ${m.masked.slice(0, 90)}`);
  for (const r of a.related.slice(0, 3)) if (r.key !== a.onset?.key) lines.push(`related ${Math.round(r.cause * 100)}% cause · ${r.source}: ${r.masked.slice(0, 90)}`);
  const flags: string[] = [];
  if (a.user_impact >= 0.6) flags.push(`user impact ${Math.round(a.user_impact * 100)}%`);
  if (a.self_healing >= 0.6) flags.push(`may self-heal ${Math.round(a.self_healing * 100)}%`);
  if (flags.length) lines.push(flags.join(" · "));
  lines.push(`next: ${a.steps.slice(0, 3).map((s, i) => `${i + 1}) ${s}`).join("  ")}`);
  return lines;
}
