import { afterEach, describe, expect, it, vi } from "vitest";

const recordSocketTelemetry = vi.fn();
vi.mock("./telemetry/clientTelemetry", () => ({
  beginApiTelemetry: () => undefined,
  finishApiTelemetry: () => undefined,
  newTelemetryId: () => "1234567890abcdef1234567890abcdef",
  recordSocketTelemetry,
}));

afterEach(() => {
  recordSocketTelemetry.mockClear();
  vi.unstubAllGlobals();
});

describe("socket recovery telemetry", () => {
  it("coalesces error-followed-by-close into one failed attempt outcome", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    vi.stubGlobal("window", { clearTimeout: vi.fn(), setTimeout: vi.fn(() => 1) });
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    });
    const { SessionSocket } = await import("./sessionSocket");
    const sessionSocket = new SessionSocket();
    sessionSocket.connect({ id: "private-session-id", cwd: "/private/workspace" }, vi.fn());
    const socket = sockets[0];
    if (socket === undefined) throw new Error("Expected socket");

    socket.onerror?.(new Event("error"));
    socket.onclose?.({ code: 1006, reason: "private reason" });

    expect(recordSocketTelemetry).toHaveBeenCalledTimes(1);
    expect(recordSocketTelemetry).toHaveBeenCalledWith({
      kind: "session",
      attemptId: "1234567890abcdef1234567890abcdef",
      generation: 1,
      outcome: "error",
      closeCode: 1006,
      delayMs: 500,
    });
    expect(JSON.stringify(recordSocketTelemetry.mock.calls)).not.toContain("private-session-id");
    expect(JSON.stringify(recordSocketTelemetry.mock.calls)).not.toContain("/private/workspace");
    expect(JSON.stringify(recordSocketTelemetry.mock.calls)).not.toContain("private reason");
  });
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  readonly readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {}

  close(): void {
    // The test drives the close callback explicitly to model error-then-close ordering.
  }
}
