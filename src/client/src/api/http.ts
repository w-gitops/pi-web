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

const AUTHENTIK_OUTPOST_PREFIX = "/outpost.goauthentik.io";
const REAUTH_HEADER = "x-pi-web-reauth";

/** A response-backed API failure, retaining the status needed at an ownership boundary. */
export class HttpRequestError extends Error {
  override name = "HttpRequestError";

  constructor(message: string, readonly status: number, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * Proxy authentication has expired or is missing. Carries no response bodies,
 * URLs, prompt text, or credentials — only a stable, user-safe message.
 */
export class AuthRequiredError extends Error {
  override readonly name = "AuthRequiredError";

  constructor(message = "Authentication required") {
    super(message);
  }
}

export function isAuthRequiredError(error: unknown): error is AuthRequiredError {
  return error instanceof AuthRequiredError;
}

/**
 * True when the response explicitly signals proxy re-authentication is required
 * (same-origin 401 with X-PI-Web-Reauth: 1, or a followed Authentik outpost URL).
 * Fetch transport failures (TypeError / "Load failed") never produce a Response
 * and must not be classified as auth here — callers treat those as delivery-unknown
 * and may later confirm auth via a safe same-origin health probe.
 */
export function isProxyAuthRequiredResponse(response: Response): boolean {
  if (response.headers.get(REAUTH_HEADER) === "1") return true;
  return isAuthentikOutpostFinalUrl(response.url);
}

export async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit, operation: ApiTelemetryOperation = "api.unknown"): Promise<T> {
  return apiRequest(url, operation, init, async (response) => {
    if (!response.ok) {
      const body: unknown = await response.json().catch((): unknown => ({}));
      throw new HttpRequestError(errorMessage(body) ?? response.statusText, response.status);
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
    if (isProxyAuthRequiredResponse(response)) throw new AuthRequiredError();
    const value = await handle(response);
    telemetry.finish(observation, response.ok ? "success" : httpOutcome(response.status), response.status);
    return value;
  } catch (error) {
    telemetry.finish(observation, response === undefined ? transportOutcome(init?.signal) : response.ok ? "parse" : httpOutcome(response.status), response?.status);
    throw error;
  }
}

function isAuthentikOutpostFinalUrl(urlString: string): boolean {
  if (urlString === "") return false;
  try {
    const pathname = new URL(urlString).pathname;
    return pathname === AUTHENTIK_OUTPOST_PREFIX || pathname.startsWith(`${AUTHENTIK_OUTPOST_PREFIX}/`);
  } catch {
    return false;
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
