import { TrailingRefreshCoordinator } from "../controllers/trailingRefreshCoordinator";

interface BrowserEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface ScheduledFrame {
  cancel(): void;
}

export interface BrowserResumeCallbacks {
  onResumeSignal(): void;
  onNetworkOnline(): void;
  onStaleResume(): void;
  refreshAfterResume(): void | Promise<void>;
  onRefreshError(error: unknown): void;
}

export interface BrowserResumeControllerOptions {
  windowTarget?: BrowserEventTarget | undefined;
  documentTarget?: BrowserEventTarget | undefined;
  isDocumentVisible?: (() => boolean) | undefined;
  scheduleFrame?: ((callback: () => void) => ScheduledFrame) | undefined;
  now?: (() => number) | undefined;
  staleResumeMs?: number | undefined;
}

const DEFAULT_STALE_RESUME_MS = 10_000;

/** Owns browser resume listeners and batches focus/visibility refreshes per frame. */
export class BrowserResumeController {
  private readonly windowTarget: BrowserEventTarget | undefined;
  private readonly documentTarget: BrowserEventTarget | undefined;
  private readonly isDocumentVisible: () => boolean;
  private readonly scheduleFrame: (callback: () => void) => ScheduledFrame;
  private readonly now: () => number;
  private readonly staleResumeMs: number;
  private readonly refreshes = new TrailingRefreshCoordinator<"browser-resume">();
  private scheduledRefresh: ScheduledFrame | undefined;
  private lastResumeSignalAt: number | undefined;
  private connected = false;

  constructor(private readonly callbacks: BrowserResumeCallbacks, options: BrowserResumeControllerOptions = {}) {
    this.windowTarget = options.windowTarget ?? browserWindowTarget();
    this.documentTarget = options.documentTarget ?? browserDocumentTarget();
    this.isDocumentVisible = options.isDocumentVisible ?? documentIsVisible;
    this.scheduleFrame = options.scheduleFrame ?? scheduleBrowserFrame;
    this.now = options.now ?? wallClockNow;
    this.staleResumeMs = options.staleResumeMs ?? DEFAULT_STALE_RESUME_MS;
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.lastResumeSignalAt = this.now();
    this.windowTarget?.addEventListener("focus", this.onFocus);
    this.windowTarget?.addEventListener("online", this.onOnline);
    this.windowTarget?.addEventListener("pageshow", this.onPageShow);
    this.documentTarget?.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.windowTarget?.removeEventListener("focus", this.onFocus);
    this.windowTarget?.removeEventListener("online", this.onOnline);
    this.windowTarget?.removeEventListener("pageshow", this.onPageShow);
    this.documentTarget?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.scheduledRefresh?.cancel();
    this.scheduledRefresh = undefined;
    this.lastResumeSignalAt = undefined;
  }

  private readonly onFocus: EventListener = () => {
    this.handleResumeSignal();
  };

  private readonly onVisibilityChange: EventListener = () => {
    if (this.isDocumentVisible()) this.handleResumeSignal();
  };

  private readonly onOnline: EventListener = () => {
    this.callbacks.onNetworkOnline();
    this.handleResumeSignal(true);
  };

  private readonly onPageShow: EventListener = () => {
    this.handleResumeSignal();
  };

  private handleResumeSignal(transportAlreadyRecovered = false): void {
    const now = this.now();
    const stale = this.lastResumeSignalAt !== undefined && now - this.lastResumeSignalAt >= this.staleResumeMs;
    this.lastResumeSignalAt = now;
    if (stale && !transportAlreadyRecovered) this.callbacks.onStaleResume();
    this.callbacks.onResumeSignal();
    if (this.scheduledRefresh !== undefined) return;
    this.scheduledRefresh = this.scheduleFrame(() => {
      this.scheduledRefresh = undefined;
      if (!this.connected) return;
      void this.refreshes.request("browser-resume", async () => {
        if (this.connected) await this.callbacks.refreshAfterResume();
      }).catch((error: unknown) => { this.callbacks.onRefreshError(error); });
    });
  }
}

function browserWindowTarget(): BrowserEventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function browserDocumentTarget(): BrowserEventTarget | undefined {
  return typeof document === "undefined" ? undefined : document;
}

// Wall-clock time intentionally advances while a mobile browser is suspended;
// performance.now() may pause during device sleep on some platforms.
function wallClockNow(): number {
  return Date.now();
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function scheduleBrowserFrame(callback: () => void): ScheduledFrame {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    const frame = window.requestAnimationFrame(() => { callback(); });
    return { cancel: () => { window.cancelAnimationFrame(frame); } };
  }
  const timer = globalThis.setTimeout(callback, 0);
  return { cancel: () => { globalThis.clearTimeout(timer); } };
}
