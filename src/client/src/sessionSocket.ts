import { realtimeEvents, sessionEvents } from "./api";
import { parseRealtimeStreamEvent, parseSessionAskClosedEvent, parseSessionAskOpenedEvent, parseSessionDialogClosedEvent, parseSessionDialogOpenedEvent, parseSessionNotificationInboxEvent, parseSessionStartupProgressEvent, parseSessionStreamEvent, parseSessionUnreadEvent } from "./api/parsers";
import type { RealtimeEvent, SessionRef, SessionUiEvent } from "../../shared/apiTypes";

export type { GlobalSessionEvent, RealtimeEvent, SessionUiEvent } from "../../shared/apiTypes";

export type BrowserRealtimeEvent = Exclude<RealtimeEvent, { type: "notifications.summary" }>;

export class SessionSocket {
  private socket: WebSocket | undefined;
  private session: SessionRef | undefined;
  private onEvent: ((event: SessionUiEvent) => void) | undefined;
  private reconnectTimer: number | undefined;
  private reconnectDelay = 500;
  private shouldReconnect = false;
  private hasOpened = false;
  private onReconnect: (() => void) | undefined;
  private onInitialOpen: (() => void) | undefined;
  private machineId = "local";
  private generation = 0;

  connect(
    session: SessionRef,
    onEvent: (event: SessionUiEvent) => void,
    onReconnect?: () => void,
    machineId = "local",
    onInitialOpen?: () => void,
  ): void {
    this.close();
    this.machineId = machineId;
    this.session = session;
    this.onEvent = onEvent;
    this.onReconnect = onReconnect;
    this.onInitialOpen = onInitialOpen;
    this.shouldReconnect = true;
    this.open();
  }

  setHandler(onEvent: (event: SessionUiEvent) => void): void {
    this.onEvent = onEvent;
  }

  reconnect(): void {
    if (!this.shouldReconnect) return;
    const generation = ++this.generation;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    closeSocketQuietly(this.socket);
    this.socket = undefined;
    this.reconnectDelay = 500;
    this.open(generation);
  }

  close(): void {
    this.generation += 1;
    this.shouldReconnect = false;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    closeSocketQuietly(this.socket);
    this.socket = undefined;
    this.session = undefined;
    this.onEvent = undefined;
    this.onReconnect = undefined;
    this.onInitialOpen = undefined;
    this.hasOpened = false;
    this.machineId = "local";
  }

  private open(generation = this.generation): void {
    const session = this.session;
    if (generation !== this.generation || session === undefined || session.id === "" || session.cwd === "" || !this.shouldReconnect) return;
    let socket: WebSocket;
    try {
      socket = sessionEvents(session, this.machineId);
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.reconnectDelay = 500;
      const isReconnect = this.hasOpened;
      this.hasOpened = true;
      if (isReconnect) this.onReconnect?.();
      else this.onInitialOpen?.();
    };
    socket.onmessage = (message) => {
      if (this.isCurrentSocket(socket, generation)) void this.handleMessage(message.data, socket, session, generation);
    };
    socket.onerror = () => {
      if (this.isCurrentSocket(socket, generation)) socket.close();
    };
    socket.onclose = () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.socket = undefined;
      this.scheduleReconnect(generation);
    };
  }

  private scheduleReconnect(generation: number): void {
    if (!this.shouldReconnect || generation !== this.generation) return;
    window.clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 5000);
    this.reconnectTimer = window.setTimeout(() => {
      if (!this.shouldReconnect || generation !== this.generation) return;
      this.reconnectTimer = undefined;
      this.open(generation);
    }, delay);
  }

  private async handleMessage(data: MessageEvent["data"], socket: WebSocket, session: SessionRef, generation: number): Promise<void> {
    const event = parseSessionSocketEvent(await parseSocketEvent(data));
    if (!this.isCurrentSocket(socket, generation) || event === undefined) return;
    if (event.type === "notifications.inbox" && (session.id !== event.summary.sessionId || session.cwd !== event.summary.cwd)) return;
    this.onEvent?.(event);
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.shouldReconnect && generation === this.generation && this.socket === socket;
  }
}

export class RealtimeSocket {
  private socket: WebSocket | undefined;
  private onEvent: ((event: BrowserRealtimeEvent) => void) | undefined;
  private onOpen: (() => void) | undefined;
  private reconnectTimer: number | undefined;
  private reconnectDelay = 500;
  private shouldReconnect = false;
  private machineId = "local";
  private generation = 0;

  connect(onEvent: (event: BrowserRealtimeEvent) => void, onOpen?: () => void, machineId = "local"): void {
    this.close();
    this.machineId = machineId;
    this.onEvent = onEvent;
    this.onOpen = onOpen;
    this.shouldReconnect = true;
    this.open();
  }

  reconnect(): void {
    if (!this.shouldReconnect) return;
    const generation = ++this.generation;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    closeSocketQuietly(this.socket);
    this.socket = undefined;
    this.reconnectDelay = 500;
    this.open(generation);
  }

  close(): void {
    this.generation += 1;
    this.shouldReconnect = false;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    closeSocketQuietly(this.socket);
    this.socket = undefined;
    this.onEvent = undefined;
    this.onOpen = undefined;
    this.machineId = "local";
  }

  private open(generation = this.generation): void {
    if (!this.shouldReconnect || generation !== this.generation) return;
    let socket: WebSocket;
    try {
      socket = realtimeEvents(this.machineId);
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.reconnectDelay = 500;
      this.onOpen?.();
    };
    socket.onmessage = (message) => {
      if (this.isCurrentSocket(socket, generation)) void this.handleMessage(message.data, socket, generation);
    };
    socket.onerror = () => {
      if (this.isCurrentSocket(socket, generation)) socket.close();
    };
    socket.onclose = () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.socket = undefined;
      this.scheduleReconnect(generation);
    };
  }

  private scheduleReconnect(generation: number): void {
    if (!this.shouldReconnect || generation !== this.generation) return;
    window.clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 5000);
    this.reconnectTimer = window.setTimeout(() => {
      if (!this.shouldReconnect || generation !== this.generation) return;
      this.reconnectTimer = undefined;
      this.open(generation);
    }, delay);
  }

  private async handleMessage(data: MessageEvent["data"], socket: WebSocket, generation: number): Promise<void> {
    const event = parseRealtimeSocketEvent(await parseSocketEvent(data));
    if (this.isCurrentSocket(socket, generation) && event !== undefined) this.onEvent?.(event);
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.shouldReconnect && generation === this.generation && this.socket === socket;
  }
}

export function parseSessionSocketEvent(event: unknown): SessionUiEvent | undefined {
  const type = eventType(event);
  // Inbox, ask, and dialog frames have dedicated validators (they drive the
  // notification inbox and the interactive cards answered on the model's or an
  // extension's behalf). Every other accepted frame is session stream
  // vocabulary, validated field by field.
  if (type === "notifications.inbox") return safelyParseValidatedEvent(() => parseSessionNotificationInboxEvent(event));
  if (type === "ask.opened") return safelyParseValidatedEvent(() => parseSessionAskOpenedEvent(event));
  if (type === "ask.closed") return safelyParseValidatedEvent(() => parseSessionAskClosedEvent(event));
  if (type === "dialog.opened") return safelyParseValidatedEvent(() => parseSessionDialogOpenedEvent(event));
  if (type === "dialog.closed") return safelyParseValidatedEvent(() => parseSessionDialogClosedEvent(event));
  const parsed = safelyParseValidatedEvent(() => parseSessionStreamEvent(event));
  return parsed === undefined ? undefined : withTransportSeq(parsed, event);
}

export function parseRealtimeSocketEvent(event: unknown): BrowserRealtimeEvent | undefined {
  const type = eventType(event);
  if (type === "sessions.unread") return safelyParseValidatedEvent(() => parseSessionUnreadEvent(event));
  if (type === "session.startup") return safelyParseValidatedEvent(() => parseSessionStartupProgressEvent(event));
  return safelyParseValidatedEvent(() => parseRealtimeStreamEvent(event));
}

// The hub stamps every per-session frame with a monotonic seq that the
// join-time exactly-once filter compares against the stream snapshot watermark.
// Validation rebuilds the event object, so the stamp must be carried over
// explicitly; a frame without a numeric stamp still flows, because the
// watermark filter fails open for unstamped events.
function withTransportSeq(event: SessionUiEvent, raw: unknown): SessionUiEvent {
  if (typeof raw !== "object" || raw === null || !("seq" in raw)) return event;
  const seq = raw.seq;
  return typeof seq === "number" ? { ...event, seq } : event;
}

function safelyParseValidatedEvent<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

function eventType(event: unknown): string {
  if (typeof event !== "object" || event === null || !("type" in event)) return "";
  const type = event.type;
  return typeof type === "string" ? type : "";
}

async function parseSocketEvent(data: MessageEvent["data"]): Promise<unknown> {
  try {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof Blob) return JSON.parse(await data.text());
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
    return undefined;
  } catch {
    return undefined;
  }
}

function closeSocketQuietly(socket: WebSocket | undefined): void {
  if (socket === undefined) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  if (socket.readyState === WebSocket.CONNECTING) {
    // Some browsers reject close() while connecting. Keep only an inert cleanup
    // callback so a replaced socket cannot survive after its handshake finishes.
    socket.onopen = () => {
      socket.onopen = null;
      tryCloseSocket(socket);
    };
    return;
  }
  tryCloseSocket(socket);
}

function tryCloseSocket(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    // Replacement has already detached this socket, so close failures are inert.
  }
}
