export interface BrowserConnectionRecoveryCallbacks {
  reconnectTransports(): void;
  probe(): Promise<boolean>;
  refresh(): void | Promise<void>;
  onStateChange(recovering: boolean): void;
  onProbeError(error: unknown): void;
}

export interface BrowserConnectionRecoveryOptions {
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  retryDelaysMs?: readonly number[] | undefined;
}

const DEFAULT_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;

/** Gates application writes until a suspended browser can reach the selected machine again. */
export class BrowserConnectionRecovery {
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private generation = 0;
  private recovering = false;

  constructor(private readonly callbacks: BrowserConnectionRecoveryCallbacks, options: BrowserConnectionRecoveryOptions = {}) {
    this.sleep = options.sleep ?? sleep;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    if (this.retryDelaysMs.length === 0) throw new Error("Browser connection recovery requires at least one retry delay");
  }

  isRecovering(): boolean {
    return this.recovering;
  }

  start(): void {
    const generation = ++this.generation;
    this.setRecovering(true);
    this.callbacks.reconnectTransports();
    void this.recover(generation);
  }

  stop(): void {
    this.generation += 1;
    this.setRecovering(false);
  }

  private async recover(generation: number): Promise<void> {
    let attempt = 0;
    while (generation === this.generation) {
      const delayMs = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 10_000;
      await this.sleep(delayMs);
      if (generation !== this.generation) return;
      try {
        if (!await this.callbacks.probe()) {
          attempt += 1;
          continue;
        }
      } catch (error) {
        this.callbacks.onProbeError(error);
        attempt += 1;
        continue;
      }
      if (generation !== this.generation) return;
      // The first replacement may itself have raced the mobile network wake-up.
      this.callbacks.reconnectTransports();
      this.setRecovering(false);
      try {
        await this.callbacks.refresh();
      } catch (error) {
        this.callbacks.onProbeError(error);
      }
      return;
    }
  }

  private setRecovering(recovering: boolean): void {
    if (this.recovering === recovering) return;
    this.recovering = recovering;
    this.callbacks.onStateChange(recovering);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => { globalThis.setTimeout(resolve, delayMs); });
}
