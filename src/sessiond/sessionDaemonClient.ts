import http from "node:http";
import { WebSocket } from "ws";
import { context, isSpanContextValid, trace, type Context } from "@opentelemetry/api";
import { isHostAbsoluteAgentDir } from "../config.js";
import type { ActiveAgentProfileDescriptor } from "../shared/apiTypes.js";
import { parsePiWebRuntimeComponent } from "../shared/piWebStatusParsing.js";
import { sessiondHttpUrl, sessiondSocketPath } from "./config.js";

const CANONICAL_TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const CANONICAL_SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;

export type SessionDaemonAgentProfileResult =
  | { status: "available"; profile: ActiveAgentProfileDescriptor }
  | { status: "unavailable"; error: string }
  | { status: "invalid"; error: string };

export interface SessionDaemonRequestOptions {
  signal?: AbortSignal;
}

export interface SessionDaemonRequestClient {
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: SessionDaemonRequestOptions,
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
}

export interface SessionDaemonClientOptions {
  baseUrl?: string;
  socketPath?: string;
  activeContext?: () => Context;
}

export class SessionDaemonClient {
  private readonly baseUrl: string | undefined;
  private readonly socketPath: string;
  private readonly activeContext: () => Context;

  constructor(options: SessionDaemonClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? sessiondHttpUrl();
    this.socketPath = options.socketPath ?? sessiondSocketPath();
    this.activeContext = options.activeContext ?? (() => context.active());
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: SessionDaemonRequestOptions = {},
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (this.baseUrl !== undefined && this.baseUrl !== "") {
      return this.requestUrl(method, path, payload, options.signal);
    }
    return this.requestSocket(method, path, payload, options.signal);
  }

  getActiveAgentProfile(): Promise<SessionDaemonAgentProfileResult> {
    return getSessionDaemonActiveAgentProfile(this);
  }

  connectWebSocket(path: string): WebSocket {
    if (this.baseUrl !== undefined && this.baseUrl !== "") {
      const url = new URL(path, this.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url);
    }
    return new WebSocket(`ws+unix:${this.socketPath}:${path}`);
  }

  private async requestUrl(method: string, path: string, payload?: string, signal?: AbortSignal) {
    const headers = new Headers(activeW3cTraceHeaders(this.activeContext()));
    const init: RequestInit = { method, headers, ...(signal === undefined ? {} : { signal }) };
    if (payload !== undefined && payload !== "") {
      headers.set("content-type", "application/json");
      init.body = payload;
    }
    const response = await fetch(new URL(path, this.baseUrl), init);
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  }

  private requestSocket(method: string, path: string, payload?: string, signal?: AbortSignal): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const headers: Record<string, string | number> = activeW3cTraceHeaders(this.activeContext());
    if (payload !== undefined && payload !== "") {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          ...(signal === undefined ? {} : { signal }),
          headers,
        },
        (response) => {
          const chunks: Uint8Array[] = [];
          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode ?? 500,
              headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("error", reject);
      if (payload !== undefined && payload !== "") request.write(payload);
      request.end();
    });
  }
}

export function activeW3cTraceHeaders(activeContext: Context = context.active()): Record<string, string> {
  const spanContext = trace.getSpanContext(activeContext);
  if (spanContext === undefined || !isSpanContextValid(spanContext)) return {};
  if (!CANONICAL_TRACE_ID.test(spanContext.traceId) || !CANONICAL_SPAN_ID.test(spanContext.spanId)) return {};
  const flags = (spanContext.traceFlags & 0x01).toString(16).padStart(2, "0");
  // Never forward inbound tracestate. Vendor values are untrusted opaque text,
  // while the canonical traceparent alone is sufficient for correlation.
  return { traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}` };
}

export async function getSessionDaemonActiveAgentProfile(client: SessionDaemonRequestClient): Promise<SessionDaemonAgentProfileResult> {
  let response: Awaited<ReturnType<SessionDaemonRequestClient["request"]>>;
  try {
    response = await client.request("GET", "/runtime");
  } catch (error) {
    return { status: "unavailable", error: errorMessage(error) };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { status: "unavailable", error: `session daemon runtime request returned HTTP ${String(response.statusCode)}` };
  }

  let value: unknown;
  try {
    value = response.body === "" ? undefined : JSON.parse(response.body);
  } catch {
    return { status: "invalid", error: "session daemon runtime response was not valid JSON" };
  }

  const runtime = parsePiWebRuntimeComponent(value);
  if (runtime?.component !== "sessiond") {
    return { status: "invalid", error: "session daemon runtime response was invalid" };
  }
  if (runtime.activeAgentProfile === undefined) {
    return { status: "invalid", error: "session daemon runtime response did not include an active agent profile" };
  }
  if (!isHostAbsoluteAgentDir(runtime.activeAgentProfile.dir)) {
    return { status: "invalid", error: "session daemon active agent profile was not valid for this host" };
  }
  return { status: "available", profile: runtime.activeAgentProfile };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
