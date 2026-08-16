import type { SessionStatus } from "../api";
import type { ChatLine } from "../components/shared";
import type { SessionUiEvent } from "../sessionSocket";
import type { PluginAssistantMessage, PluginAssistantOutput, PluginAssistantOutputEvent, PluginMachine } from "./types";

export interface AssistantOutputSelection {
  machine: PluginMachine;
  sessionId: string;
  messages: readonly ChatLine[];
  status: SessionStatus | undefined;
}

export class AssistantOutputProjector {
  private active: PluginAssistantOutput | undefined;

  snapshot(selection: AssistantOutputSelection): PluginAssistantOutputEvent {
    const output = latestAssistantOutput(selection);
    this.active = output?.state === "streaming" ? output : undefined;
    return output === undefined ? { type: "snapshot" } : { type: "snapshot", output };
  }

  apply(event: SessionUiEvent, selection: AssistantOutputSelection): PluginAssistantOutputEvent | undefined {
    if (event.type === "pi.event" && event.eventType === "turn_start") {
      const interrupted = this.interrupted(selection.sessionId, "turn-started");
      this.active = undefined;
      return interrupted;
    }
    if (event.type === "assistant.delta") {
      const output = latestAssistantOutput(selection, true);
      if (output === undefined) return undefined;
      const started = this.active?.id !== output.id;
      this.active = output;
      return started ? { type: "started", output } : { type: "delta", output, delta: event.text };
    }
    if (event.type === "message.end" && assistantMessage(event.message)) {
      const output = latestAssistantOutput(selection, false);
      if (output === undefined) return undefined;
      const completed: PluginAssistantOutput = this.active?.sessionId === selection.sessionId
        ? { ...output, id: this.active.id, state: "complete" }
        : { ...output, state: "complete" };
      this.active = undefined;
      return { type: "completed", output: completed };
    }
    return undefined;
  }

  clear(sessionId: string, reason: "session-changed" | "session-cleared"): PluginAssistantOutputEvent {
    const event = this.interrupted(sessionId, reason);
    this.active = undefined;
    return event;
  }

  private interrupted(sessionId: string, reason: "session-changed" | "turn-started" | "session-cleared"): PluginAssistantOutputEvent {
    return this.active === undefined
      ? { type: "interrupted", sessionId, reason }
      : { type: "interrupted", sessionId, outputId: this.active.id, reason };
  }
}

export function assistantMessageProjection(
  message: ChatLine,
  index: number,
  sessionId: string,
  machine: PluginMachine,
  streaming: boolean,
): PluginAssistantMessage | undefined {
  if (message.role !== "assistant") return undefined;
  const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  if (text === "") return undefined;
  return {
    id: `${sessionId}:${message.meta?.timestamp ?? `message-${String(index)}`}`,
    sessionId,
    machine,
    text,
    streaming,
  };
}

function latestAssistantOutput(selection: AssistantOutputSelection, streamingOverride?: boolean): PluginAssistantOutput | undefined {
  for (let index = selection.messages.length - 1; index >= 0; index -= 1) {
    const message = selection.messages[index];
    if (message === undefined) continue;
    const projected = assistantMessageProjection(
      message,
      index,
      selection.sessionId,
      selection.machine,
      (streamingOverride ?? selection.status?.isStreaming === true) && index === selection.messages.length - 1,
    );
    if (projected !== undefined) {
      return { ...projected, state: projected.streaming ? "streaming" : "complete" };
    }
  }
  return undefined;
}

function assistantMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null && "role" in value && value.role === "assistant";
}
