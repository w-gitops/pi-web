import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createTraceState, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { activeW3cTraceHeaders, SessionDaemonClient } from "./sessionDaemonClient.js";

const traceA = "1234567890abcdef1234567890abcdef";
const spanA = "1234567890abcdef";
const traceB = "abcdef1234567890abcdef1234567890";
const spanB = "abcdef1234567890";
const servers: Server[] = [];
const tempDirs: string[] = [];
const networkListenersBlocked = process.env["CODEX_SANDBOX_NETWORK_DISABLED"] === "1";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => { resolve(); }))));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionDaemonClient W3C propagation", () => {
  it("injects one canonical active trace context and no baggage", () => {
    const contextWithSpan = trace.setSpanContext(ROOT_CONTEXT, { traceId: traceA, spanId: spanA, traceFlags: TraceFlags.SAMPLED });
    expect(activeW3cTraceHeaders(contextWithSpan)).toEqual({ traceparent: `00-${traceA}-${spanA}-01` });
    const contextWithUntrustedTraceState = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: traceA,
      spanId: spanA,
      traceFlags: TraceFlags.SAMPLED,
      traceState: createTraceState("vendor=private-value"),
    });
    expect(activeW3cTraceHeaders(contextWithUntrustedTraceState)).toEqual({ traceparent: `00-${traceA}-${spanA}-01` });
    expect(activeW3cTraceHeaders(ROOT_CONTEXT)).toEqual({});
    expect(activeW3cTraceHeaders(trace.setSpanContext(ROOT_CONTEXT, { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: TraceFlags.NONE }))).toEqual({});
    expect(activeW3cTraceHeaders(trace.setSpanContext(ROOT_CONTEXT, { traceId: traceA.toUpperCase(), spanId: spanA, traceFlags: TraceFlags.NONE }))).toEqual({});
    expect(activeW3cTraceHeaders(trace.setSpanContext(ROOT_CONTEXT, { traceId: traceA, spanId: spanA.toUpperCase(), traceFlags: TraceFlags.NONE }))).toEqual({});
    expect(activeW3cTraceHeaders(trace.setSpanContext(ROOT_CONTEXT, { traceId: traceA, spanId: "0".repeat(16), traceFlags: TraceFlags.NONE }))).toEqual({});
  });

  it.skipIf(networkListenersBlocked)("propagates isolated concurrent contexts through the TCP transport", async () => {
    const received = new Map<string, string | undefined>();
    const server = createServer((request, response) => {
      received.set(request.url ?? "", singleHeader(request.headers["traceparent"]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");

    const manager = new AsyncLocalStorage<Context>();
    const client = new SessionDaemonClient({ baseUrl: `http://127.0.0.1:${String(address.port)}`, activeContext: () => manager.getStore() ?? ROOT_CONTEXT });
    const contextA = trace.setSpanContext(ROOT_CONTEXT, { traceId: traceA, spanId: spanA, traceFlags: TraceFlags.SAMPLED });
    const contextB = trace.setSpanContext(ROOT_CONTEXT, { traceId: traceB, spanId: spanB, traceFlags: TraceFlags.NONE });
    await Promise.all([
      manager.run(contextA, () => client.request("GET", "/a")),
      manager.run(contextB, () => client.request("GET", "/b")),
      manager.run(ROOT_CONTEXT, () => client.request("GET", "/none")),
    ]);
    manager.disable();

    expect(received).toEqual(new Map([
      ["/a", `00-${traceA}-${spanA}-01`],
      ["/b", `00-${traceB}-${spanB}-00`],
      ["/none", undefined],
    ]));
  });

  it.skipIf(process.platform === "win32" || networkListenersBlocked)("propagates active context through a Unix socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-otel-"));
    tempDirs.push(directory);
    const socketPath = join(directory, "sessiond.sock");
    let received: string | undefined;
    const server = createServer((request, response) => {
      received = singleHeader(request.headers["traceparent"]);
      response.writeHead(204);
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const contextWithSpan = trace.setSpanContext(ROOT_CONTEXT, { traceId: traceA, spanId: spanA, traceFlags: TraceFlags.SAMPLED });
    const client = new SessionDaemonClient({ socketPath, activeContext: () => contextWithSpan });

    await client.request("POST", "/sessions/private/prompt", { opaque: true });

    expect(received).toBe(`00-${traceA}-${spanA}-01`);
  });
});

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}
