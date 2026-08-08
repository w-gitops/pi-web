import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiTelemetryMethod } from "../../shared/clientTelemetry.js";
import { emitTelemetryLog } from "./logs.js";

const SAFE_ROUTE_TEMPLATE = /^\/[A-Za-z0-9_*/:.-]{0,159}$/;

export function registerFastifyTelemetryHooks(app: FastifyInstance, now: () => number = () => performance.now()): void {
  const starts = new WeakMap<FastifyRequest, number>();
  const errored = new WeakSet<FastifyRequest>();
  app.addHook("onRequest", (request, _reply, done) => {
    starts.set(request, now());
    done();
  });
  app.addHook("onError", (request, _reply, _error, done) => {
    errored.add(request);
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    if (reply.statusCode >= 500 || errored.has(request)) {
      emitTelemetryLog({
        event: "http.server.error",
        method: normalizeMethod(request.method),
        route: safeRouteTemplate(request.routeOptions.url),
        status: boundedStatus(reply.statusCode),
        durationMs: Math.min(3_600_000, Math.max(0, now() - (starts.get(request) ?? now()))),
      });
    }
    done();
  });
}

export function safeRouteTemplate(route: string | undefined): string {
  return route !== undefined && SAFE_ROUTE_TEMPLATE.test(route) ? route : "unknown";
}

function normalizeMethod(method: string): ApiTelemetryMethod {
  return method === "DELETE" || method === "GET" || method === "PATCH" || method === "POST" || method === "PUT" ? method : "OTHER";
}

function boundedStatus(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
}
