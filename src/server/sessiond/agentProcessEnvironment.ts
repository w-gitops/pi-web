/**
 * Environment hygiene for agent-executed processes.
 *
 * Sessions run inside the session daemon process, so everything agents can
 * spawn — the bash tool, terminals, subsessions — inherits the daemon's
 * environment by default. That environment carries PI WEB's own runtime
 * configuration: deployment keys such as `NODE_ENV=production` baked into the
 * Docker image, and the daemon's `PI_WEB_*` wiring (data dir, socket, ports,
 * feature switches). Those keys are meant for the daemon, not for agents:
 * `NODE_ENV=production` makes npm skip devDependencies and flips Node
 * package-export conditions, and inherited `PI_WEB_DATA_DIR` /
 * `PI_WEB_SESSIOND_SOCKET` make a second PI WEB instance started from inside a
 * session point at the live daemon's state.
 *
 * The daemon captures its environment once at startup for its own use and then
 * removes every non-agent-visible key from `process.env`, so all later spawns
 * inherit a clean environment without per-call-site filtering. Visibility
 * rules:
 *
 * - Ordinary variables (`PATH`, `HOME`, `XDG_CONFIG_HOME`, proxy keys, …)
 *   stay.
 * - `PI_WEB_*` keys are daemon configuration and are removed — including keys
 *   added in the future — except `PI_WEB_DOCKER_*` deployment descriptors,
 *   which the agent-facing `pi-web-docker` CLI reads.
 * - `HOSTEXEC_*` stays: agents use `hostexec`.
 * - Every `OTEL_*` key is removed after the daemon's telemetry bootstrap has
 *   captured and applied it. This prevents agent children from exporting
 *   unrelated work with the daemon's collector, headers, or service identity.
 * - `PI_CODING_AGENT_DIR` stays so agent-spawned `pi` CLIs find the profile's
 *   auth and models; `PI_CODING_AGENT_SESSION_DIR` is daemon session-discovery
 *   wiring and is removed.
 * - `NODE_ENV` and `PORT` are app-runtime configuration, removed like
 *   `PI_WEB_*`. Nothing in PI WEB reads `NODE_ENV` at runtime, but tools
 *   agents run (npm, Vite, Node itself) change behavior based on it.
 */

/** Deployment descriptors agent-facing tools (`pi-web-docker`) legitimately read. */
const AGENT_VISIBLE_PI_WEB_PREFIXES = ["PI_WEB_DOCKER_"] as const;

/**
 * Non-`PI_WEB_` keys that still configure the daemon or app rather than the
 * processes agents run. Daemon configuration should use `PI_WEB_`-prefixed
 * keys so it is covered by the prefix rule above; a key only belongs here when
 * it cannot carry the prefix (deployment conventions like `NODE_ENV`) or is a
 * compatibility name owned by the companion CLI (`PI_CODING_AGENT_*`).
 */
const DAEMON_ONLY_ENV_KEYS = new Set(["NODE_ENV", "PORT", "PI_CODING_AGENT_SESSION_DIR"]);

export function isAgentVisibleEnvKey(key: string): boolean {
  if (key.startsWith("PI_WEB_")) return AGENT_VISIBLE_PI_WEB_PREFIXES.some((prefix) => key.startsWith(prefix));
  if (key.startsWith("OTEL_")) return false;
  return !DAEMON_ONLY_ENV_KEYS.has(key);
}

/**
 * Delete every non-agent-visible key from `env` — the daemon's `process.env`
 * at startup — and return the removed key names, sorted, for logging.
 */
export function scrubNonAgentVisibleEnvKeys(env: NodeJS.ProcessEnv): string[] {
  const scrubbed = Object.keys(env).filter((key) => !isAgentVisibleEnvKey(key));
  for (const key of scrubbed) {
    // process.env is a dynamic key/value bag; deleting the daemon-only keys is
    // the whole point of the scrub, and the keys cannot be known statically.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete env[key];
  }
  return scrubbed.sort();
}
