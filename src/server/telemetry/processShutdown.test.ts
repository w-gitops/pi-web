import { describe, expect, it, vi } from "vitest";
import { boundedProcessShutdown } from "./processShutdown.js";

describe("process shutdown bound", () => {
  it("settles at the deadline even when application close never resolves", async () => {
    vi.useFakeTimers();
    const result = boundedProcessShutdown(() => new Promise<void>(() => undefined), 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("preserves ordered shutdown when operations settle", async () => {
    const calls: string[] = [];
    await boundedProcessShutdown(async () => {
      calls.push("application");
      await Promise.resolve();
      calls.push("telemetry");
    });
    expect(calls).toEqual(["application", "telemetry"]);
  });
});
