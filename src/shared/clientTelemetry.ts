export const CLIENT_TELEMETRY_MAX_EVENTS = 20;

export const API_TELEMETRY_OPERATIONS = [
  "api.unknown",
  "config.read",
  "machine.list",
  "pi-web.status",
  "plugin.list",
  "project.list",
  "session.list",
  "session.messages",
  "session.prompt",
  "session.status",
  "session.stream-snapshot",
  "session.tree-fork",
  "session.unread",
  "terminal.command-lookup",
  "workspace.activity",
  "workspace.list",
] as const;

export type ApiTelemetryOperation = typeof API_TELEMETRY_OPERATIONS[number];
export type ApiTelemetryMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT" | "OTHER";
export type ApiTelemetryOutcome = "abort" | "http.4xx" | "http.5xx" | "http.other" | "network" | "parse" | "success" | "timeout";
export type SocketTelemetryKind = "realtime" | "session";
export type SocketTelemetryOutcome = "close" | "error" | "open" | "replaced" | "scheduled";
export type BrowserTelemetryOutcome = "focus" | "offline" | "online" | "visible";

interface ClientTelemetryBase {
  online: boolean;
  visible: boolean;
}

export interface ClientApiTelemetryEvent extends ClientTelemetryBase {
  type: "api";
  requestId: string;
  operation: ApiTelemetryOperation;
  method: ApiTelemetryMethod;
  outcome: ApiTelemetryOutcome;
  status?: number;
  durationMs: number;
}

export interface ClientSocketTelemetryEvent extends ClientTelemetryBase {
  type: "socket";
  kind: SocketTelemetryKind;
  attemptId: string;
  generation: number;
  outcome: SocketTelemetryOutcome;
  closeCode?: number;
  delayMs?: number;
}

export interface ClientBrowserTelemetryEvent extends ClientTelemetryBase {
  type: "browser";
  outcome: BrowserTelemetryOutcome;
}

export type ClientTelemetryEvent = ClientApiTelemetryEvent | ClientSocketTelemetryEvent | ClientBrowserTelemetryEvent;

export interface ClientTelemetryBatch {
  version: 1;
  events: ClientTelemetryEvent[];
}

const API_METHODS = new Set<string>(["DELETE", "GET", "PATCH", "POST", "PUT", "OTHER"]);
const API_OUTCOMES = new Set<string>(["abort", "http.4xx", "http.5xx", "http.other", "network", "parse", "success", "timeout"]);
const API_OPERATIONS = new Set<string>(API_TELEMETRY_OPERATIONS);
const SOCKET_KINDS = new Set<string>(["realtime", "session"]);
const SOCKET_OUTCOMES = new Set<string>(["close", "error", "open", "replaced", "scheduled"]);
const BROWSER_OUTCOMES = new Set<string>(["focus", "offline", "online", "visible"]);
const OPAQUE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;

export function parseClientTelemetryBatch(value: unknown): ClientTelemetryBatch | undefined {
  if (!isExactRecord(value, ["version", "events"]) || value["version"] !== 1 || !Array.isArray(value["events"])) return undefined;
  if (value["events"].length === 0 || value["events"].length > CLIENT_TELEMETRY_MAX_EVENTS) return undefined;
  const events: ClientTelemetryEvent[] = [];
  for (const candidate of value["events"]) {
    const event = parseClientTelemetryEvent(candidate);
    if (event === undefined) return undefined;
    events.push(event);
  }
  return { version: 1, events };
}

function parseClientTelemetryEvent(value: unknown): ClientTelemetryEvent | undefined {
  if (!isRecord(value) || typeof value["type"] !== "string") return undefined;
  if (value["type"] === "api") return parseApiEvent(value);
  if (value["type"] === "socket") return parseSocketEvent(value);
  if (value["type"] === "browser") return parseBrowserEvent(value);
  return undefined;
}

function parseApiEvent(value: Record<string, unknown>): ClientApiTelemetryEvent | undefined {
  const allowed = ["type", "requestId", "operation", "method", "outcome", "status", "durationMs", "online", "visible"];
  if (!hasOnlyKeys(value, allowed) || !hasRequiredKeys(value, allowed.filter((key) => key !== "status"))) return undefined;
  const requestId = value["requestId"];
  const operation = value["operation"];
  const method = value["method"];
  const outcome = value["outcome"];
  const durationMs = value["durationMs"];
  const status = value["status"];
  if (typeof requestId !== "string" || !OPAQUE_ID.test(requestId)) return undefined;
  if (!isApiOperation(operation) || !isApiMethod(method) || !isApiOutcome(outcome)) return undefined;
  if (!isBoundedNumber(durationMs, 0, 3_600_000)) return undefined;
  if (status !== undefined && !isBoundedInteger(status, 100, 599)) return undefined;
  if (!hasBrowserState(value)) return undefined;
  return {
    type: "api",
    requestId,
    operation,
    method,
    outcome,
    ...(status === undefined ? {} : { status }),
    durationMs,
    online: value.online,
    visible: value.visible,
  };
}

function parseSocketEvent(value: Record<string, unknown>): ClientSocketTelemetryEvent | undefined {
  const allowed = ["type", "kind", "attemptId", "generation", "outcome", "closeCode", "delayMs", "online", "visible"];
  if (!hasOnlyKeys(value, allowed) || !hasRequiredKeys(value, allowed.filter((key) => key !== "closeCode" && key !== "delayMs"))) return undefined;
  const kind = value["kind"];
  const attemptId = value["attemptId"];
  const generation = value["generation"];
  const outcome = value["outcome"];
  const closeCode = value["closeCode"];
  const delayMs = value["delayMs"];
  if (!isSocketKind(kind)) return undefined;
  if (typeof attemptId !== "string" || !OPAQUE_ID.test(attemptId)) return undefined;
  if (!isBoundedInteger(generation, 0, 1_000_000_000)) return undefined;
  if (!isSocketOutcome(outcome)) return undefined;
  if (closeCode !== undefined && !isBoundedInteger(closeCode, 0, 4999)) return undefined;
  if (delayMs !== undefined && !isBoundedNumber(delayMs, 0, 300_000)) return undefined;
  if (!hasBrowserState(value)) return undefined;
  return {
    type: "socket",
    kind,
    attemptId,
    generation,
    outcome,
    ...(closeCode === undefined ? {} : { closeCode }),
    ...(delayMs === undefined ? {} : { delayMs }),
    online: value.online,
    visible: value.visible,
  };
}

function parseBrowserEvent(value: Record<string, unknown>): ClientBrowserTelemetryEvent | undefined {
  const allowed = ["type", "outcome", "online", "visible"];
  if (!isExactRecord(value, allowed) || !hasBrowserState(value)) return undefined;
  const outcome = value["outcome"];
  if (!isBrowserOutcome(outcome)) return undefined;
  return { type: "browser", outcome, online: value.online, visible: value.visible };
}

function isApiOperation(value: unknown): value is ApiTelemetryOperation {
  return typeof value === "string" && API_OPERATIONS.has(value);
}

function isApiMethod(value: unknown): value is ApiTelemetryMethod {
  return typeof value === "string" && API_METHODS.has(value);
}

function isApiOutcome(value: unknown): value is ApiTelemetryOutcome {
  return typeof value === "string" && API_OUTCOMES.has(value);
}

function isSocketKind(value: unknown): value is SocketTelemetryKind {
  return typeof value === "string" && SOCKET_KINDS.has(value);
}

function isSocketOutcome(value: unknown): value is SocketTelemetryOutcome {
  return typeof value === "string" && SOCKET_OUTCOMES.has(value);
}

function isBrowserOutcome(value: unknown): value is BrowserTelemetryOutcome {
  return typeof value === "string" && BROWSER_OUTCOMES.has(value);
}

function hasBrowserState(value: Record<string, unknown>): value is Record<string, unknown> & { online: boolean; visible: boolean } {
  return typeof value["online"] === "boolean" && typeof value["visible"] === "boolean";
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && isBoundedNumber(value, minimum, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, keys) && hasRequiredKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
