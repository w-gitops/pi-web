import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseClientTelemetryBatch, type ClientTelemetryEvent } from "../../shared/clientTelemetry.js";
import { recordClientTelemetryEvent } from "./logs.js";

const CLIENT_TELEMETRY_BODY_LIMIT = 16 * 1024;

export interface ClientTelemetryAdmissionOptions {
  now?: () => number;
  globalCapacity?: number;
  globalRefillPerSecond?: number;
  sourceCapacity?: number;
  sourceRefillPerSecond?: number;
  acceptedEventBudget?: number;
  maxSources?: number;
}

export class ClientTelemetryAdmission {
  private readonly now: () => number;
  private readonly global: TokenBucket;
  private readonly sourceCapacity: number;
  private readonly sourceRefillPerSecond: number;
  private readonly acceptedEventBudget: number;
  private readonly maxSources: number;
  private readonly sources = new Map<string, TokenBucket>();
  private acceptedEvents = 0;

  constructor(options: ClientTelemetryAdmissionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.global = new TokenBucket(options.globalCapacity ?? 200, options.globalRefillPerSecond ?? 2, this.now);
    this.sourceCapacity = options.sourceCapacity ?? 40;
    this.sourceRefillPerSecond = options.sourceRefillPerSecond ?? 0.5;
    this.acceptedEventBudget = options.acceptedEventBudget ?? 20_000;
    this.maxSources = options.maxSources ?? 256;
  }

  admit(source: string, eventCount: number): boolean {
    if (this.acceptedEvents + eventCount > this.acceptedEventBudget) return false;
    let sourceBucket = this.sources.get(source);
    if (sourceBucket === undefined) {
      if (this.sources.size >= this.maxSources) return false;
      sourceBucket = new TokenBucket(this.sourceCapacity, this.sourceRefillPerSecond, this.now);
      this.sources.set(source, sourceBucket);
    }
    if (!sourceBucket.available(eventCount) || !this.global.available(eventCount)) return false;
    sourceBucket.consume(eventCount);
    this.global.consume(eventCount);
    this.acceptedEvents += eventCount;
    return true;
  }
}

export interface ClientTelemetryIntakeOptions {
  enabled: boolean;
  admission?: ClientTelemetryAdmission;
  record?: (event: ClientTelemetryEvent) => void;
}

export function registerClientTelemetryIntake(app: FastifyInstance, options: ClientTelemetryIntakeOptions): void {
  const admission = options.admission ?? new ClientTelemetryAdmission();
  const record = options.record ?? recordClientTelemetryEvent;

  app.get("/api/client-telemetry", () => ({ enabled: options.enabled }));
  app.post<{ Body: unknown }>("/api/client-telemetry", {
    bodyLimit: CLIENT_TELEMETRY_BODY_LIMIT,
    onRequest: (request, reply, done) => {
      if (!options.enabled) {
        void reply.code(204).send();
        return;
      }
      done();
    },
  }, async (request, reply) => {
    if (!sameOriginRequest(request)) return reply.code(403).send({ error: "Client telemetry requires a same-origin request" });
    if (!isJsonContentType(request.headers["content-type"])) return reply.code(415).send({ error: "Client telemetry requires JSON" });
    const batch = parseClientTelemetryBatch(request.body);
    if (batch === undefined) return reply.code(400).send({ error: "Invalid client telemetry batch" });
    if (!admission.admit(request.ip, batch.events.length)) return reply.code(429).send({ error: "Client telemetry admission limit reached" });
    for (const event of batch.events) record(event);
    return reply.code(204).send();
  });
}

function sameOriginRequest(request: Pick<FastifyRequest, "headers">): boolean {
  const fetchSite = singleHeader(request.headers["sec-fetch-site"]);
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;
  const origin = singleHeader(request.headers.origin);
  if (origin === undefined) return true;
  const host = singleHeader(request.headers.host);
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(private readonly capacity: number, private readonly refillPerSecond: number, private readonly now: () => number) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  available(count: number): boolean {
    this.refill();
    return count > 0 && this.tokens >= count;
  }

  consume(count: number): void {
    this.refill();
    this.tokens -= count;
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1_000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = now;
  }
}
