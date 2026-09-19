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
