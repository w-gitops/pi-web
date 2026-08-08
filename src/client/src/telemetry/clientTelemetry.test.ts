import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientTelemetry } from "./clientTelemetry";

type RawFetch = ConstructorParameters<typeof ClientTelemetry>[0]["rawFetch"];

describe("ClientTelemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/app/" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is inert when discovery is disabled", async () => {
    const rawFetch = vi.fn<RawFetch>().mockResolvedValue(jsonResponse({ enabled: false }));
    const telemetry = createTelemetry(rawFetch);

    await expect(telemetry.start()).resolves.toBe(false);
    telemetry.recordBrowser("online");
    await vi.runAllTimersAsync();

    expect(rawFetch).toHaveBeenCalledTimes(1);
  });

  it("buffers bounded early failures while enablement discovery is pending", async () => {
    let enable: ((response: Response) => void) | undefined;
    const discovery = new Promise<Response>((resolve) => { enable = resolve; });
    const rawFetch = vi.fn<RawFetch>()
      .mockReturnValueOnce(discovery)
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    const telemetry = createTelemetry(rawFetch);

    const starting = telemetry.start();
    const observation = telemetry.beginApi("session.prompt", "POST");
    telemetry.finishApi(observation, "network");
    expect(observation).toBeDefined();
    expect(rawFetch).toHaveBeenCalledOnce();

    enable?.(jsonResponse({ enabled: true }));
    await expect(starting).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(rawFetch).toHaveBeenCalledTimes(2);
    expect(bodyText(rawFetch.mock.calls[1]?.[1]?.body)).toContain('"operation":"session.prompt"');
  });

  it("discards early observations when discovery reports telemetry disabled", async () => {
    let disable: ((response: Response) => void) | undefined;
    const discovery = new Promise<Response>((resolve) => { disable = resolve; });
    const rawFetch = vi.fn<RawFetch>().mockReturnValueOnce(discovery);
    const telemetry = createTelemetry(rawFetch);

    const starting = telemetry.start();
    telemetry.finishApi(telemetry.beginApi("session.prompt", "POST"), "network");
    disable?.(jsonResponse({ enabled: false }));
    await expect(starting).resolves.toBe(false);
    await vi.runAllTimersAsync();

    expect(rawFetch).toHaveBeenCalledOnce();
  });

  it("uses a separate bounded transport and never serializes free-form failure text", async () => {
    const rawFetch = vi.fn<RawFetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    const telemetry = createTelemetry(rawFetch);
    await telemetry.start();

    const observation = telemetry.beginApi("session.prompt", "POST");
    telemetry.finishApi(observation, "network");
    await vi.advanceTimersByTimeAsync(250);

    expect(rawFetch).toHaveBeenCalledTimes(2);
    const body = bodyText(rawFetch.mock.calls[1]?.[1]?.body);
    expect(body).toContain('"operation":"session.prompt"');
    expect(body).not.toContain("Bearer secret");
    expect(body).not.toContain("/home/user");
    expect(body).not.toContain("prompt body");
  });

  it("retains one failed batch and probes recovery with capped full jitter while online stays true", async () => {
    const rawFetch = vi.fn<RawFetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockRejectedValueOnce(new Error("origin down at /private?token=secret"))
      .mockResolvedValueOnce(new Response(undefined, { status: 503 }))
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    const telemetry = createTelemetry(rawFetch, { random: () => 0.5, online: () => true });
    await telemetry.start();
    telemetry.recordBrowser("focus");

    await vi.advanceTimersByTimeAsync(250);
    expect(rawFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(rawFetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(rawFetch).toHaveBeenCalledTimes(4);
    expect(rawFetch.mock.calls[1]?.[1]?.body).toBe(rawFetch.mock.calls[2]?.[1]?.body);
    expect(rawFetch.mock.calls[2]?.[1]?.body).toBe(rawFetch.mock.calls[3]?.[1]?.body);
  });

  it("prevents overlapping flushes and caps queued events", async () => {
    let resolvePost: ((response: Response) => void) | undefined;
    const post = new Promise<Response>((resolve) => { resolvePost = resolve; });
    const rawFetch = vi.fn<RawFetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockReturnValueOnce(post)
      .mockResolvedValue(new Response(undefined, { status: 204 }));
    const telemetry = createTelemetry(rawFetch);
    await telemetry.start();
    for (let index = 0; index < 80; index += 1) telemetry.recordBrowser("online");

    await vi.advanceTimersByTimeAsync(250);
    void telemetry.flush();
    expect(rawFetch).toHaveBeenCalledTimes(2);
    resolvePost?.(new Response(undefined, { status: 204 }));
    await post;
    await vi.runAllTimersAsync();

    const batchSizes = rawFetch.mock.calls.slice(1).map((call) => eventCount(call[1]?.body));
    expect(batchSizes.every((size) => size <= 20)).toBe(true);
    expect(batchSizes.reduce((count, size) => count + size, 0)).toBeLessThanOrEqual(50);
  });

  it("caps socket diagnostics independently by kind and window", async () => {
    const rawFetch = vi.fn<RawFetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: true }))
      .mockResolvedValue(new Response(undefined, { status: 204 }));
    const telemetry = createTelemetry(rawFetch);
    await telemetry.start();
    for (let index = 0; index < 30; index += 1) {
      telemetry.recordSocket({ kind: "session", attemptId: idFor(index), generation: index, outcome: "error" });
    }
    await vi.runAllTimersAsync();

    expect(eventCount(rawFetch.mock.calls[1]?.[1]?.body)).toBe(20);
  });

  it("fails open when the pagehide beacon transport throws", async () => {
    const rawFetch = vi.fn<RawFetch>().mockResolvedValueOnce(jsonResponse({ enabled: true }));
    const telemetry = createTelemetry(rawFetch, { sendBeacon: () => { throw new Error("transport unavailable"); } });
    await telemetry.start();
    telemetry.recordBrowser("focus");

    expect(() => { telemetry.dispose(); }).not.toThrow();
    expect(rawFetch).toHaveBeenCalledTimes(1);
  });
});

function createTelemetry(rawFetch: ConstructorParameters<typeof ClientTelemetry>[0]["rawFetch"], overrides: Partial<ConstructorParameters<typeof ClientTelemetry>[0]> = {}): ClientTelemetry {
  return new ClientTelemetry({
    rawFetch,
    now: () => Date.now(),
    random: () => 0,
    online: () => true,
    visible: () => true,
    ...overrides,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function idFor(index: number): string {
  return index.toString(16).padStart(32, "0").replace(/^0{32}$/, "00000000000000000000000000000001");
}

function eventCount(body: BodyInit | null | undefined): number {
  const value: unknown = JSON.parse(bodyText(body));
  if (typeof value !== "object" || value === null || !("events" in value) || !Array.isArray(value.events)) throw new Error("Expected telemetry batch");
  return value.events.length;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("Expected string request body");
  return body;
}
