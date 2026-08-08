import { describe, expect, it, vi } from "vitest";
import { BrowserResumeController } from "./browserResumeController";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolveDeferred = resolve; });
  if (resolveDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred };
}

function frameHarness() {
  const frames: { callback: () => void; canceled: boolean }[] = [];
  return {
    scheduleFrame: (callback: () => void) => {
      const frame = { callback, canceled: false };
      frames.push(frame);
      return { cancel: () => { frame.canceled = true; } };
    },
    pendingCount: () => frames.filter((frame) => !frame.canceled).length,
    runNext: () => {
      const frame = frames.shift();
      if (frame === undefined) throw new Error("No scheduled frame");
      if (!frame.canceled) frame.callback();
    },
  };
}

describe("BrowserResumeController", () => {
  it("batches overlapping focus and visible signals into one app refresh", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const refreshGate = deferred<undefined>();
    const refreshStarted = deferred<undefined>();
    const refreshCompleted = deferred<undefined>();
    const onResumeSignal = vi.fn();
    const onNetworkOnline = vi.fn();
    let visible = true;
    let refreshCalls = 0;
    const controller = new BrowserResumeController({
      onResumeSignal,
      onNetworkOnline,
      refreshAfterResume: async () => {
        refreshCalls += 1;
        refreshStarted.resolve(undefined);
        await refreshGate.promise;
        refreshCompleted.resolve(undefined);
      },
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => visible,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("focus"));

    expect(onResumeSignal).toHaveBeenCalledTimes(3);
    expect(onNetworkOnline).not.toHaveBeenCalled();
    expect(frames.pendingCount()).toBe(1);
    expect(refreshCalls).toBe(0);

    frames.runNext();
    await refreshStarted.promise;
    expect(refreshCalls).toBe(1);

    visible = false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(onResumeSignal).toHaveBeenCalledTimes(3);
    expect(frames.pendingCount()).toBe(0);

    refreshGate.resolve(undefined);
    await refreshCompleted.promise;
    windowTarget.dispatchEvent(new Event("focus"));
    expect(frames.pendingCount()).toBe(1);
    controller.disconnect();
    frames.runNext();
    await Promise.resolve();
    windowTarget.dispatchEvent(new Event("focus"));
    expect(onResumeSignal).toHaveBeenCalledTimes(4);
    expect(refreshCalls).toBe(1);
  });

  it("runs one trailing refresh when another resume arrives during active work", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const firstGate = deferred<undefined>();
    const secondGate = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const secondStarted = deferred<undefined>();
    const secondCompleted = deferred<undefined>();
    let refreshCalls = 0;
    const controller = new BrowserResumeController({
      onResumeSignal: () => undefined,
      onNetworkOnline: () => undefined,
      refreshAfterResume: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          firstStarted.resolve(undefined);
          await firstGate.promise;
          return;
        }
        secondStarted.resolve(undefined);
        await secondGate.promise;
        secondCompleted.resolve(undefined);
      },
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => true,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("focus"));
    frames.runNext();
    await firstStarted.promise;

    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(frames.pendingCount()).toBe(1);
    frames.runNext();
    expect(refreshCalls).toBe(1);

    firstGate.resolve(undefined);
    await secondStarted.promise;
    expect(refreshCalls).toBe(2);

    secondGate.resolve(undefined);
    await secondCompleted.promise;
    controller.disconnect();
  });

  it("recovers transports immediately on online and batches its refresh even while hidden", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const frames = frameHarness();
    const calls: string[] = [];
    const controller = new BrowserResumeController({
      onNetworkOnline: () => { calls.push("online"); },
      onResumeSignal: () => { calls.push("resume"); },
      refreshAfterResume: () => { calls.push("refresh"); },
      onRefreshError: (error) => { throw error; },
    }, {
      windowTarget,
      documentTarget,
      isDocumentVisible: () => false,
      scheduleFrame: frames.scheduleFrame,
    });
    controller.connect();

    windowTarget.dispatchEvent(new Event("online"));

    expect(calls).toEqual(["online", "resume"]);
    expect(frames.pendingCount()).toBe(1);
    frames.runNext();
    await Promise.resolve();
    expect(calls).toEqual(["online", "resume", "refresh"]);

    controller.disconnect();
    windowTarget.dispatchEvent(new Event("online"));
    expect(calls).toEqual(["online", "resume", "refresh"]);
  });
});
