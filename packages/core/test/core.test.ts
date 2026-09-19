import { test, expect } from "bun:test";
import { mask, templateKey, buildRequest, jevClient, validateRules, migrate, ingest, defaultShouldAlert, defaultRules, type Event } from "../src/index";
import { bunSqlite } from "../src/store-bun";

test("mask collapses variables into a stable template", () => {
  const a = mask('GET /api/users/42 500 in 1532ms req=8f3c2a1b9d0e4f5a6b7c8d9e0f1a2b3c "Timeout waiting for pg"');
  const b = mask('GET /api/users/7 500 in 98ms req=aaaaaaaabbbbbbbbccccccccdddddddd "Timeout waiting for pg"');
  expect(a).toBe(b);
  expect(a).toContain("<PATH>");
  expect(a).toContain("<STR>");
});

test("templateKey differs by source and level", async () => {
  const x = await templateKey("vercel", "error", "boom 1");
  const y = await templateKey("sentry", "error", "boom 2");
  expect(x.key).not.toBe(y.key);
  expect((await templateKey("vercel", "error", "boom 3")).key).toBe(x.key);
});

test("buildRequest keys questions by event id and keeps rule fields", () => {
  const rules = validateRules(defaultRules);
  const req = buildRequest([{ source: "s", level: "error", message: "m" }], rules);
  expect(Object.keys(req.questions)).toContain("e0.severity");
  expect((req.questions["e0.severity"] as any).criteria).toHaveLength(4);
  expect((req.questions["e0.is_failure"] as any).instructions).toMatch(/^Look only at the event with id "e0"/);
});

function fakeJev(calls: any[] = []) {
  const f = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    const answers: any = {};
    for (const e of body.state.events) {
      const bad = /timeout|error|exception/i.test(e.message);
      answers[`${e.id}.is_failure`] = { type: "noul", noul: bad ? 0.95 : 0.05 };
      answers[`${e.id}.needs_human`] = { type: "noul", noul: bad ? 0.8 : 0.1 };
      answers[`${e.id}.severity`] = { type: "score", score: bad ? 2.3 : 0.1, confidence: 0.7, probabilities: {} };
      answers[`${e.id}.category`] = { type: "choice", choice: bad ? "timeout" : "other", confidence: 0.9, probabilities: {} };
      answers[`${e.id}.security`] = { type: "noul", noul: 0.02 };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 * body.state.events.length } }), { status: 200 });
  }) as any;
  return { client: jevClient("k", f), calls };
}

const ev = (i: number, message: string, level: Event["level"] = "error"): Event =>
  ({ id: `id${i}`, tenant: "t1", source: "vercel", ts: 1_700_000_000_000 + i, level, message });

test("ingest judges one sample per template, alerts once, respects cooldown", async () => {
  const store = await bunSqlite(":memory:");
  await migrate(store);
  const { client, calls } = fakeJev();
  const config = { rules: validateRules(defaultRules), rejudgeAfterMs: 3_600_000, alertCooldownMs: 3_600_000, shouldAlert: defaultShouldAlert };
  const events = [
    ...Array.from({ length: 50 }, (_, i) => ev(i, `Timeout waiting for pg after ${100 + i}ms`)),
    ev(100, "GET /health 200 in 3ms", "info"),
    ev(101, "GET /health 200 in 5ms", "info"),
  ];
  const r1 = await ingest(events, { store, jev: client, config });
  expect(r1.received).toBe(52);
  expect(r1.judged).toBe(2);                       // two templates, not 52 events
  expect(calls[0].state.events).toHaveLength(2);
  expect(r1.alerts).toHaveLength(1);
  expect(r1.alerts[0].meta?.occurrences).toBe(50);
  expect(r1.alerts[0].novel).toBe(true);

  const r2 = await ingest([ev(200, "Timeout waiting for pg after 999ms")], { store, jev: client, config });
  expect(r2.judged).toBe(0);                       // cached template
  expect(r2.alerts).toHaveLength(0);               // cooldown
  const t = await store.all<{ count: number }>(`SELECT count FROM templates WHERE tenant = 't1' ORDER BY count DESC LIMIT 1`);
  expect(t[0].count).toBe(51);
  const n = await store.all<{ n: number }>(`SELECT COUNT(*) AS n FROM events`);
  expect(n[0].n).toBe(53);
});

test("mask handles numbers after underscores and inside identifiers", () => {
  expect(mask("rate limit hit for key ak_74152513 (429)")).toBe(mask("rate limit hit for key ak_31790077 (429)"));
  expect(mask("container api-7f9c killed")).toBe(mask("container api-7f9c killed"));
});
