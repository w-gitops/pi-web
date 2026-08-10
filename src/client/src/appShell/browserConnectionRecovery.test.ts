import { describe, expect, it, vi } from "vitest";
import { BrowserConnectionRecovery } from "./browserConnectionRecovery";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolvePromise };
}

describe("BrowserConnectionRecovery", () => {
  it("blocks writes until an idempotent probe succeeds, then reconnects again and refreshes", async () => {
    const sleeps: number[] = [];
    const outcomes = [false, false, true];
    const reconnectTransports = vi.fn();
    const refresh = vi.fn();
    const states: boolean[] = [];
    const recovery = new BrowserConnectionRecovery({
      reconnectTransports,
      probe: () => Promise.resolve(outcomes.shift() ?? false),
      refresh,
      onStateChange: (recovering) => { states.push(recovering); },
      onProbeError: (error) => { throw error; },
    }, {
      retryDelaysMs: [0, 25, 50],
      sleep: (delayMs) => { sleeps.push(delayMs); return Promise.resolve(); },
    });

    recovery.start();
    expect(recovery.isRecovering()).toBe(true);
    expect(reconnectTransports).toHaveBeenCalledOnce();
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce(); });

    expect(sleeps).toEqual([0, 25, 50]);
    expect(reconnectTransports).toHaveBeenCalledTimes(2);
    expect(states).toEqual([true, false]);
    expect(recovery.isRecovering()).toBe(false);
  });

  it("invalidates an older probe loop when a newer resume signal starts recovery", async () => {
    const firstProbe = deferred();
    let probes = 0;
    const reconnectTransports = vi.fn();
    const recovery = new BrowserConnectionRecovery({
      reconnectTransports,
      probe: async () => {
        probes += 1;
        if (probes === 1) await firstProbe.promise;
        return true;
      },
      refresh: () => undefined,
      onStateChange: () => undefined,
      onProbeError: (error) => { throw error; },
    }, { sleep: () => Promise.resolve(), retryDelaysMs: [0] });

    recovery.start();
    await vi.waitFor(() => { expect(probes).toBe(1); });
    recovery.start();
    await vi.waitFor(() => { expect(recovery.isRecovering()).toBe(false); });
    firstProbe.resolve();
    await Promise.resolve();

    expect(reconnectTransports).toHaveBeenCalledTimes(3);
  });

  it("stops an in-flight loop without refreshing", async () => {
    const waiting = deferred();
    const refresh = vi.fn();
    const recovery = new BrowserConnectionRecovery({
      reconnectTransports: () => undefined,
      probe: () => Promise.resolve(true),
      refresh,
      onStateChange: () => undefined,
      onProbeError: (error) => { throw error; },
    }, { sleep: () => waiting.promise, retryDelaysMs: [0] });

    recovery.start();
    recovery.stop();
    waiting.resolve();
    await Promise.resolve();

    expect(recovery.isRecovering()).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
