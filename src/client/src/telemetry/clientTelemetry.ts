import type {
  ApiTelemetryMethod,
  ApiTelemetryOperation,
  ApiTelemetryOutcome,
  BrowserTelemetryOutcome,
  ClientTelemetryBatch,
  ClientTelemetryEvent,
  SocketTelemetryKind,
  SocketTelemetryOutcome,
} from "../../../shared/clientTelemetry";
import { resolveAppUrl } from "../appUrl";

const MAX_QUEUED_EVENTS = 50;
const MAX_SOCKET_EVENTS_PER_WINDOW = 20;
const SOCKET_EVENT_WINDOW_MS = 60_000;
const FLUSH_DEBOUNCE_MS = 250;
const FAILED_BATCH_TTL_MS = 120_000;
const RECOVERY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

type Timer = ReturnType<typeof setTimeout>;
type RawFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ClientTelemetryDependencies {
  rawFetch: RawFetch;
  sendBeacon?: (url: string, data: BodyInit) => boolean;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer | undefined) => void;
  online?: () => boolean;
  visible?: () => boolean;
  addWindowListener?: (type: "focus" | "offline" | "online" | "pagehide", listener: EventListener) => void;
  removeWindowListener?: (type: "focus" | "offline" | "online" | "pagehide", listener: EventListener) => void;
  addVisibilityListener?: (listener: EventListener) => void;
  removeVisibilityListener?: (listener: EventListener) => void;
}

interface RetainedBatch {
  events: ClientTelemetryEvent[];
  expiresAt: number;
}

export interface ApiTelemetryObservation {
  requestId: string;
  operation: ApiTelemetryOperation;
  method: ApiTelemetryMethod;
  startedAt: number;
}

export interface SocketTelemetryInput {
  kind: SocketTelemetryKind;
  attemptId: string;
  generation: number;
  outcome: SocketTelemetryOutcome;
  closeCode?: number;
  delayMs?: number;
}

export class ClientTelemetry {
  private readonly rawFetch: RawFetch;
  private readonly sendBeacon: ((url: string, data: BodyInit) => boolean) | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer | undefined) => void;
  private readonly online: () => boolean;
  private readonly visible: () => boolean;
  private readonly addWindowListener: ClientTelemetryDependencies["addWindowListener"];
  private readonly removeWindowListener: ClientTelemetryDependencies["removeWindowListener"];
  private readonly addVisibilityListener: ClientTelemetryDependencies["addVisibilityListener"];
  private readonly removeVisibilityListener: ClientTelemetryDependencies["removeVisibilityListener"];
  private readonly queue: ClientTelemetryEvent[] = [];
  private readonly socketWindows = new Map<SocketTelemetryKind, { startedAt: number; count: number }>();
  private retained: RetainedBatch | undefined;
  private flushTimer: Timer | undefined;
  private retryTimer: Timer | undefined;
  private retryIndex = 0;
  private enabled = false;
  private started = false;
  private discovering = false;
  private inFlight = false;
  private disposed = false;

  constructor(deps: ClientTelemetryDependencies) {
    this.rawFetch = deps.rawFetch;
    this.sendBeacon = deps.sendBeacon;
    this.now = deps.now ?? (() => performance.now());
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((timer) => { if (timer !== undefined) clearTimeout(timer); });
    this.online = deps.online ?? (() => navigator.onLine);
    this.visible = deps.visible ?? (() => document.visibilityState === "visible");
    this.addWindowListener = deps.addWindowListener;
    this.removeWindowListener = deps.removeWindowListener;
    this.addVisibilityListener = deps.addVisibilityListener;
    this.removeVisibilityListener = deps.removeVisibilityListener;
  }

  async start(): Promise<boolean> {
    if (this.started || this.disposed) return this.enabled;
    this.started = true;
    this.discovering = true;
    try {
      const response = await this.rawFetch(resolveAppUrl("api/client-telemetry"), {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return this.finishDiscovery(false);
      const body: unknown = await response.json();
      if (!isEnabledResponse(body)) return this.finishDiscovery(false);
      return this.finishDiscovery(true);
    } catch {
      return this.finishDiscovery(false);
    }
  }

  isEnabled(): boolean {
    return this.enabled && !this.disposed;
  }

  newAttemptId(): string | undefined {
    return this.isCollecting() ? opaqueId() : undefined;
  }

  beginApi(operation: ApiTelemetryOperation, method: string | undefined): ApiTelemetryObservation | undefined {
    if (!this.isCollecting()) return undefined;
    return { requestId: opaqueId(), operation, method: normalizeMethod(method), startedAt: this.now() };
  }

  finishApi(observation: ApiTelemetryObservation | undefined, outcome: ApiTelemetryOutcome, status?: number): void {
    // Successful server requests are already represented by server spans. Keep
    // browser intake focused on failures to bound volume on active clients.
    if (observation === undefined || outcome === "success" || !this.isCollecting()) return;
    this.enqueue({
      type: "api",
      requestId: observation.requestId,
      operation: observation.operation,
      method: observation.method,
      outcome,
      ...(status === undefined ? {} : { status }),
      durationMs: Math.max(0, this.now() - observation.startedAt),
      ...this.browserState(),
    });
  }

  recordSocket(input: SocketTelemetryInput): void {
    if (!this.isCollecting() || !this.admitSocketEvent(input.kind)) return;
    this.enqueue({ type: "socket", ...input, ...this.browserState() });
  }

  recordBrowser(outcome: BrowserTelemetryOutcome): void {
    if (!this.isEnabled()) return;
    this.enqueue({ type: "browser", outcome, ...this.browserState() });
  }

  async flush(): Promise<void> {
    if (!this.isEnabled() || this.inFlight) return;
    this.clearTimer(this.flushTimer);
    this.flushTimer = undefined;
    this.dropExpiredRetained();
    const fromRetained = this.retained !== undefined;
    const events = fromRetained ? this.retained?.events : this.queue.splice(0, 20);
    if (events === undefined || events.length === 0) return;

    this.inFlight = true;
    try {
      const batch: ClientTelemetryBatch = { version: 1, events };
      const response = await this.rawFetch(resolveAppUrl("api/client-telemetry"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        keepalive: true,
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error("telemetry delivery rejected");
      if (fromRetained) this.retained = undefined;
      this.retryIndex = 0;
    } catch {
      if (!fromRetained) this.retained = { events, expiresAt: this.now() + FAILED_BATCH_TTL_MS };
      this.scheduleRecovery();
    } finally {
      this.inFlight = false;
    }
    if (this.retained === undefined && this.queue.length > 0) this.scheduleFlush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.flushBeacon();
    this.disposed = true;
    this.enabled = false;
    this.clearTimer(this.flushTimer);
    this.clearTimer(this.retryTimer);
    this.flushTimer = undefined;
    this.retryTimer = undefined;
    this.detachListeners();
  }

  private enqueue(event: ClientTelemetryEvent): void {
    if (this.queue.length >= MAX_QUEUED_EVENTS) this.queue.shift();
    this.queue.push(event);
    if (this.enabled) this.scheduleFlush();
  }

  private finishDiscovery(enabled: boolean): boolean {
    this.discovering = false;
    this.enabled = enabled;
    if (!enabled) {
      this.queue.length = 0;
      return false;
    }
    this.attachListeners();
    if (this.queue.length > 0) this.scheduleFlush();
    return true;
  }

  private isCollecting(): boolean {
    return !this.disposed && (this.discovering || this.enabled);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.retained !== undefined || this.inFlight) return;
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private scheduleRecovery(): void {
    if (this.retryTimer !== undefined || this.retryIndex >= RECOVERY_DELAYS_MS.length) return;
    const ceiling = RECOVERY_DELAYS_MS[this.retryIndex];
    if (ceiling === undefined) return;
    this.retryIndex += 1;
    const delay = Math.floor(this.random() * ceiling);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, delay);
  }

  private triggerRecovery(): void {
    if (!this.isEnabled()) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
    if (this.retained !== undefined) void this.flush();
    else this.scheduleFlush();
  }

  private flushBeacon(): void {
    if (!this.isEnabled() || this.inFlight || this.sendBeacon === undefined) return;
    this.dropExpiredRetained();
    const fromRetained = this.retained !== undefined;
    const events = fromRetained ? this.retained?.events : this.queue.slice(0, 20);
    if (events === undefined || events.length === 0) return;
    const batch: ClientTelemetryBatch = { version: 1, events };
    let accepted: boolean;
    try {
      accepted = this.sendBeacon(resolveAppUrl("api/client-telemetry"), new Blob([JSON.stringify(batch)], { type: "application/json" }));
    } catch {
      return;
    }
    if (!accepted) return;
    if (fromRetained) this.retained = undefined;
    else this.queue.splice(0, events.length);
  }

  private dropExpiredRetained(): void {
    if (this.retained !== undefined && this.retained.expiresAt <= this.now()) {
      this.retained = undefined;
      this.retryIndex = 0;
    }
  }

  private admitSocketEvent(kind: SocketTelemetryKind): boolean {
    const now = this.now();
    const window = this.socketWindows.get(kind);
    if (window === undefined || now - window.startedAt >= SOCKET_EVENT_WINDOW_MS) {
      this.socketWindows.set(kind, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= MAX_SOCKET_EVENTS_PER_WINDOW) return false;
    window.count += 1;
    return true;
  }

  private browserState(): { online: boolean; visible: boolean } {
    return { online: this.online(), visible: this.visible() };
  }

  private readonly onOnline: EventListener = () => { this.recordBrowser("online"); this.triggerRecovery(); };
  private readonly onOffline: EventListener = () => { this.recordBrowser("offline"); };
  private readonly onFocus: EventListener = () => { this.recordBrowser("focus"); this.triggerRecovery(); };
  private readonly onPageHide: EventListener = () => { this.flushBeacon(); };
  private readonly onVisibility: EventListener = () => {
    if (!this.visible()) return;
    this.recordBrowser("visible");
    this.triggerRecovery();
  };

  private attachListeners(): void {
    this.addWindowListener?.("online", this.onOnline);
    this.addWindowListener?.("offline", this.onOffline);
    this.addWindowListener?.("focus", this.onFocus);
    this.addWindowListener?.("pagehide", this.onPageHide);
    this.addVisibilityListener?.(this.onVisibility);
  }

  private detachListeners(): void {
    this.removeWindowListener?.("online", this.onOnline);
    this.removeWindowListener?.("offline", this.onOffline);
    this.removeWindowListener?.("focus", this.onFocus);
    this.removeWindowListener?.("pagehide", this.onPageHide);
    this.removeVisibilityListener?.(this.onVisibility);
  }
}

let defaultTelemetry: ClientTelemetry | undefined;

export async function startClientTelemetry(): Promise<boolean> {
  if (defaultTelemetry === undefined) {
    const rawFetch = globalThis.fetch.bind(globalThis);
    const sendBeacon = typeof navigator.sendBeacon === "function" ? navigator.sendBeacon.bind(navigator) : undefined;
    defaultTelemetry = new ClientTelemetry({
      rawFetch,
      ...(sendBeacon === undefined ? {} : { sendBeacon }),
      addWindowListener: (type, listener) => { window.addEventListener(type, listener); },
      removeWindowListener: (type, listener) => { window.removeEventListener(type, listener); },
      addVisibilityListener: (listener) => { document.addEventListener("visibilitychange", listener); },
      removeVisibilityListener: (listener) => { document.removeEventListener("visibilitychange", listener); },
    });
  }
  return defaultTelemetry.start();
}

export function beginApiTelemetry(operation: ApiTelemetryOperation, method: string | undefined): ApiTelemetryObservation | undefined {
  return defaultTelemetry?.beginApi(operation, method);
}

export function finishApiTelemetry(observation: ApiTelemetryObservation | undefined, outcome: ApiTelemetryOutcome, status?: number): void {
  defaultTelemetry?.finishApi(observation, outcome, status);
}

export function recordSocketTelemetry(input: SocketTelemetryInput): void {
  defaultTelemetry?.recordSocket(input);
}

export function newTelemetryId(): string | undefined {
  return defaultTelemetry?.newAttemptId();
}

function opaqueId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  if (bytes.every((value) => value === 0)) bytes[15] = 1;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeMethod(method: string | undefined): ApiTelemetryMethod {
  const upper = (method ?? "GET").toUpperCase();
  return upper === "DELETE" || upper === "GET" || upper === "PATCH" || upper === "POST" || upper === "PUT" ? upper : "OTHER";
}

function isEnabledResponse(value: unknown): value is { enabled: true } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && "enabled" in value && value.enabled === true;
}
