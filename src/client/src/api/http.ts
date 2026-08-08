import { resolveAppUrl } from "../appUrl";
import type { ApiTelemetryOperation, ApiTelemetryOutcome } from "../../../shared/clientTelemetry";
import { beginApiTelemetry, finishApiTelemetry } from "../telemetry/clientTelemetry";

export interface ApiRequestTelemetry {
  begin(operation: ApiTelemetryOperation, method: string | undefined): ReturnType<typeof beginApiTelemetry>;
  finish(observation: ReturnType<typeof beginApiTelemetry>, outcome: ApiTelemetryOutcome, status?: number): void;
}

const DEFAULT_API_REQUEST_TELEMETRY: ApiRequestTelemetry = {
  begin: beginApiTelemetry,
  finish: finishApiTelemetry,
};

export async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit, operation: ApiTelemetryOperation = "api.unknown"): Promise<T> {
  return apiRequest(url, operation, init, async (response) => {
    if (!response.ok) {
      const body: unknown = await response.json().catch((): unknown => ({}));
      throw new Error(errorMessage(body) ?? response.statusText);
    }
    const body: unknown = await response.json();
    return parse(body);
  });
}

export async function apiRequest<T>(
  url: string,
  operation: ApiTelemetryOperation,
  init: RequestInit | undefined,
  handle: (response: Response) => Promise<T>,
  telemetry: ApiRequestTelemetry = DEFAULT_API_REQUEST_TELEMETRY,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const observation = telemetry.begin(operation, init?.method);
  if (observation !== undefined) headers.set("x-pi-web-request-id", observation.requestId);
  let response: Response | undefined;
  try {
    response = await fetch(resolveAppUrl(url), { ...init, headers });
    const value = await handle(response);
    telemetry.finish(observation, response.ok ? "success" : httpOutcome(response.status), response.status);
    return value;
  } catch (error) {
    telemetry.finish(observation, response === undefined ? transportOutcome(init?.signal) : response.ok ? "parse" : httpOutcome(response.status), response?.status);
    throw error;
  }
}

function httpOutcome(status: number): ApiTelemetryOutcome {
  if (status >= 400 && status <= 499) return "http.4xx";
  if (status >= 500 && status <= 599) return "http.5xx";
  return "http.other";
}

function transportOutcome(signal: AbortSignal | null | undefined): ApiTelemetryOutcome {
  if (signal?.aborted !== true) return "network";
  const reason: unknown = signal.reason;
  return typeof reason === "object" && reason !== null && "name" in reason && reason.name === "TimeoutError" ? "timeout" : "abort";
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
