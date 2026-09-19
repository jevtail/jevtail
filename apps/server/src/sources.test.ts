import { test, expect } from "bun:test";
import { lineToEvent } from "./sources";

test("lineToEvent: json lines keep level and message, plain lines are classified by keyword", () => {
  const j = lineToEvent("gostop", '{"level":"warn","msg":"room 8F2K idle 30m","ts":"2026-09-19T01:02:03Z"}')!;
  expect(j.level).toBe("warn"); expect(j.message).toBe("room 8F2K idle 30m"); expect(j.ts).toBe(Date.parse("2026-09-19T01:02:03Z"));
  expect(lineToEvent("x", "2026-09-19 ERROR failed to connect to redis")!.level).toBe("error");
  expect(lineToEvent("x", "Traceback (most recent call last):")!.level).toBe("error");
  expect(lineToEvent("x", "GET /health 200")!.level).toBe("info");
  expect(lineToEvent("x", "   ")).toBeNull();
});
