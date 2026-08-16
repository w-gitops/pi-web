import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import type { ChatLine } from "../components/shared";
import { AssistantOutputProjector, assistantMessageProjection } from "./assistantOutput";

const machine = { id: "remote", name: "Remote", kind: "remote" as const };
const line = (text: string, timestamp = "2026-01-02T03:04:05Z"): ChatLine => ({
  role: "assistant",
  parts: [{ type: "thinking", text: "private reasoning" }, { type: "text", text }],
  meta: { timestamp },
});
const selection = (messages: ChatLine[], isStreaming: boolean) => {
  const status: SessionStatus = {
    sessionId: "session-1",
    isStreaming,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  return { machine, sessionId: "session-1", messages, status };
};

describe("AssistantOutputProjector", () => {
  it("projects speakable text without thinking content and preserves remote identity", () => {
    expect(assistantMessageProjection(line("Hello"), 0, "session-1", machine, true)).toEqual({
      id: "session-1:2026-01-02T03:04:05Z",
      sessionId: "session-1",
      machine,
      text: "Hello",
      streaming: true,
    });
  });

  it("baselines reconnect snapshots instead of replaying a completed event", () => {
    const projector = new AssistantOutputProjector();
    expect(projector.snapshot(selection([line("Already present")], false))).toMatchObject({
      type: "snapshot",
      output: { text: "Already present", state: "complete" },
    });
  });

  it("emits a start, exactly-once deltas, and the reconciled final tail", () => {
    const projector = new AssistantOutputProjector();
    projector.snapshot(selection([], false));
    expect(projector.apply({ type: "assistant.delta", text: "Hel" }, selection([line("Hel")], true))).toMatchObject({ type: "started", output: { text: "Hel" } });
    expect(projector.apply({ type: "assistant.delta", text: "lo" }, selection([line("Hello")], true))).toMatchObject({ type: "delta", delta: "lo", output: { text: "Hello" } });
    expect(projector.apply({ type: "message.end", message: { role: "assistant" } }, selection([line("Hello!")], false))).toMatchObject({ type: "completed", output: { text: "Hello!", state: "complete" } });
  });

  it("interrupts active speech when a new turn starts", () => {
    const projector = new AssistantOutputProjector();
    projector.apply({ type: "assistant.delta", text: "Hi" }, selection([line("Hi")], true));
    expect(projector.apply({ type: "pi.event", eventType: "turn_start" }, selection([line("Hi")], true))).toEqual({
      type: "interrupted",
      sessionId: "session-1",
      outputId: "session-1:2026-01-02T03:04:05Z",
      reason: "turn-started",
    });
  });
});
