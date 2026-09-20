import { test, expect } from "bun:test";
import { migrate, ingest, validateRules, defaultRules, defaultShouldAlert, analyze, renderAnalysis, type Event } from "../src/index";
import { bunSqlite } from "../src/store-bun";

// fake Jev that answers both the rules and the analysis questions by keyword
const fakeFetch = (async (_u: string, init: any) => {
  const body = JSON.parse(init.body); const answers: any = {};
  for (const [k, q] of Object.entries<any>(body.questions)) {
    const ins = String(q.instructions);
    const id = k.split(".")[0]; const cand = (body.state.candidates ?? body.state.events ?? []).find((c: any) => c.id === id);
    const msg = String(cand?.message ?? "");
    if (k.endsWith(".related")) answers[k] = { type: "noul", noul: /postgres|db|connection/i.test(msg) ? 0.9 : 0.05 };
    else if (k.endsWith(".cause")) answers[k] = { type: "noul", noul: /database system is ready|too many connections/i.test(msg) ? 0.85 : 0.1 };
    else if (k.endsWith(".change")) answers[k] = { type: "noul", noul: /database system is ready|starting/i.test(msg) ? 0.9 : 0.05 };
    else if (k === "hypothesis") answers[k] = { type: "choice", choice: "dependency", confidence: 0.78, probabilities: { dependency: 0.7, resource: 0.2, unknown: 0.1 } };
    else if (k === "self_healing") answers[k] = { type: "noul", noul: 0.2 };
    else if (k === "user_impact") answers[k] = { type: "noul", noul: 0.9 };
    else if (q.type === "noul") answers[k] = { type: "noul", noul: /ECONNREFUSED|too many/i.test(msg) ? 0.9 : 0.05 };
    else if (q.type === "score") answers[k] = { type: "score", score: /ECONNREFUSED/i.test(msg) ? 2.4 : /too many/i.test(msg) ? 1.8 : 0.1, confidence: 0.8, probabilities: {} };
    else if (q.type === "choice") answers[k] = { type: "choice", choice: /ECONNREFUSED/i.test(msg) ? "dependency" : "other", confidence: 0.9, probabilities: {} };
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), { status: 200 });
}) as any;

test("analyze: finds the restart as onset/change marker, the cause template, and a hypothesis with steps", async () => {
  const store = await bunSqlite(":memory:"); await migrate(store);
  const { jevClient } = await import("../src/jev");
  const jev = jevClient("k", fakeFetch);
  const config = { rules: validateRules(defaultRules), rejudgeAfterMs: 3_600_000, alertCooldownMs: 3_600_000, shouldAlert: defaultShouldAlert };
  const t0 = 1_700_000_000_000;
  const ev = (i: number, source: string, message: string, level: Event["level"], dt: number): Event => ({ id: `e${i}`, tenant: "default", source, ts: t0 + dt, level, message });
  await ingest([
    ev(1, "docker:kingsick-db", "LOG: database system is ready to accept connections", "info", -5 * 60_000),
    ev(2, "supabase:postgres", "FATAL: too many connections for role kingsick", "error", -4 * 60_000),
    ev(3, "docker:kingsick-frontend", "GET /static/app.js 200 in 3ms", "info", -3 * 60_000),
  ], { store, jev, config });
  const r = await ingest([ev(4, "docker:kingsick-backend", "Error: connect ECONNREFUSED 10.0.0.8:5432 (pool exhausted after 19s)", "error", 0)], { store, jev, config });
  expect(r.alerts).toHaveLength(1);
  const a = await analyze(r.alerts[0], { store, apiKey: "k", fetchImpl: fakeFetch });
  expect(a.hypothesis).toBe("dependency");
  expect(a.confidence).toBe(0.78);
  expect(a.onset?.source).toBe("docker:kingsick-db");
  expect(a.change_markers.map((c) => c.source)).toContain("docker:kingsick-db");
  expect(a.related.map((c) => c.source)).toContain("supabase:postgres");
  expect(a.related.map((c) => c.source)).not.toContain("docker:kingsick-frontend");
  expect(a.steps.length).toBeGreaterThan(0);
  const text = renderAnalysis(a, r.alerts[0].ts).join("\n");
  expect(text).toContain("why (78%)");
  expect(text).toContain("onset");
  expect(text).toContain("5 min before");
  expect(text).toContain("user impact 90%");
});
