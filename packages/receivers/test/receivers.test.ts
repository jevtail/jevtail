import { test, expect } from "bun:test";
import { sentry, vercel, generic, supabase } from "../src/index";
const h = new Headers();

test("sentry: integration webhook shape", () => {
  const body = { action: "created", data: { event: { title: "TypeError: x is undefined", level: "error", timestamp: 1758240000, web_url: "https://sentry.io/x/1", environment: "production", exception: { values: [{ type: "TypeError", value: "x is undefined" }] } }, issue: { project: { slug: "web" } } } };
  const [e] = sentry(body, h, "t");
  expect(e.source).toBe("sentry"); expect(e.level).toBe("error"); expect(e.message).toBe("TypeError: x is undefined");
  expect(e.ts).toBe(1758240000000); expect(e.link).toBe("https://sentry.io/x/1"); expect(e.meta?.environment).toBe("production");
});

test("sentry: legacy alert shape", () => {
  const [e] = sentry({ project: "web", level: "warning", url: "https://sentry.io/y", event: { message: "slow query", timestamp: "2026-09-19T00:00:00Z" } }, h, "t");
  expect(e.level).toBe("warn"); expect(e.message).toBe("slow query"); expect(e.link).toBe("https://sentry.io/y"); expect(e.meta?.project).toBe("web");
});

test("vercel: ndjson drain, status -> level", () => {
  const nd = [
    JSON.stringify({ id: "a", timestamp: 1758240000123, message: "Error: ECONNRESET", source: "lambda", projectName: "shop", deploymentId: "dpl_1", path: "/api/pay", statusCode: 500 }),
    JSON.stringify({ id: "b", timestamp: 1758240000456, source: "lambda", projectName: "shop", path: "/", proxy: { method: "GET", statusCode: 200, path: "/" } }),
  ].join("\n");
  const ev = vercel(nd, h, "t");
  expect(ev).toHaveLength(2);
  expect(ev[0].level).toBe("error"); expect(ev[0].message).toBe("Error: ECONNRESET"); expect(ev[0].link).toContain("dpl_1");
  expect(ev[1].level).toBe("info"); expect(ev[1].message).toBe("GET / 200");
});

test("generic: array, wrapped, and plain lines", () => {
  expect(generic([{ message: "hi", level: "warn" }], h, "t")[0].level).toBe("warn");
  expect(generic({ events: [{ msg: "x", ts: "2026-09-19T00:00:00Z" }] }, h, "t")[0].ts).toBe(Date.parse("2026-09-19T00:00:00Z"));
  const lines = generic("plain line one\n{\"message\":\"json line\",\"source\":\"nginx\"}", h, "t");
  expect(lines.map((e) => e.message)).toEqual(["plain line one", "json line"]);
  expect(lines[1].source).toBe("nginx");
});

test("supabase: batch with metadata", () => {
  const [e] = supabase([{ id: "1", timestamp: 1758240000000000, event_message: "connection reset by peer", metadata: { level: "error", project: "abc" } }], h, "t");
  expect(e.source).toBe("supabase"); expect(e.level).toBe("error"); expect(e.meta?.project).toBe("abc");
});

test("supabase: unified logs rows with flattened attributes, zone-less UTC timestamps, json auth messages", () => {
  const rows = [
    { timestamp: "2026-09-19T05:32:24.503132", source: "postgrest_logs", event_message: "Warp server error: Thread killed by timeout manager", log_attributes: { host: "db-abc", project: "abc" } },
    { timestamp: "2026-09-19T03:22:07.430000", source: "postgres_logs", event_message: "checkpoint complete: wrote 31 buffers", log_attributes: { "parsed.error_severity": "LOG", "parsed.sql_state_code": "00000", project: "abc" } },
    { timestamp: "2026-09-19T04:57:47.494000", source: "edge_logs", event_message: "GET | 500 | https://abc.supabase.co/rest/v1/users?select=name | node", log_attributes: { project: "abc" } },
    { timestamp: "2026-09-19T04:57:47.000000", source: "auth_logs", event_message: '{"component":"api","level":"error","method":"POST","msg":"request failed","path":"/token","error":"invalid_grant"}', log_attributes: { level: "error", method: "POST", path: "/token" } },
  ];
  const ev = supabase(rows, h, "t");
  expect(ev.map((e) => e.source)).toEqual(["supabase:postgrest", "supabase:postgres", "supabase:edge", "supabase:auth"]);
  expect(ev[0].level).toBe("error"); expect(ev[0].ts).toBe(Date.parse("2026-09-19T05:32:24.503Z"));
  expect(ev[1].level).toBe("info"); expect(ev[1].meta?.sql_state).toBe("00000");
  expect(ev[2].level).toBe("error"); expect(ev[2].meta?.status).toBe(500); expect(ev[2].meta?.path).toBe("/rest/v1/users");
  expect(ev[3].message).toBe("request failed POST /token invalid_grant"); expect(ev[3].level).toBe("error");
});

test("sentry: issue counts, tag arrays, culprit appended to message", () => {
  const body = { action: "created", data: {
    event: { event_id: "8a3c", title: "TypeError: Cannot read properties of undefined (reading 'filter')", level: "error", datetime: "2026-09-17T13:41:39.679Z", web_url: "https://minkyu.sentry.io/issues/OPHILIAPICTURE-W", culprit: "/", platform: "javascript",
      tags: [["environment", "production"], ["handled", "no"], ["mechanism", "onunhandledrejection"], ["url", "https://www.ophiliapicture.com/"], ["release", "cDAH1jKL"]] },
    issue: { shortId: "OPHILIAPICTURE-W", count: "2325", userCount: 45, issueCategory: "error", issueType: "error", project: { slug: "ophiliapicture" } } } };
  const [e] = sentry(body, h, "t");
  expect(e.id).toBe("8a3c");
  expect(e.message).toBe("TypeError: Cannot read properties of undefined (reading 'filter') (at /)");
  expect(e.meta).toMatchObject({ project: "ophiliapicture", environment: "production", handled: "no", events: 2325, users: 45, issue: "OPHILIAPICTURE-W", issue_category: "error", url: "https://www.ophiliapicture.com/" });
});

test("sentry: resolved / assigned / ignored issue webhooks are skipped", () => {
  const mk = (action: string) => ({ action, data: { issue: { shortId: "X-1", title: "boom", level: "error", web_url: "https://s/x" } } });
  expect(sentry(mk("resolved"), h, "t")).toHaveLength(0);
  expect(sentry(mk("assigned"), h, "t")).toHaveLength(0);
  expect(sentry(mk("ignored"), h, "t")).toHaveLength(0);
  expect(sentry(mk("created"), h, "t")).toHaveLength(1);
  expect(sentry(mk("unresolved"), h, "t")).toHaveLength(1);
});
