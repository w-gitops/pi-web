import { describe, expect, it } from "vitest";
import { isAgentVisibleEnvKey, scrubNonAgentVisibleEnvKeys } from "./agentProcessEnvironment.js";

describe("agent process environment visibility", () => {
  it("keeps the ordinary environment agent processes rely on", () => {
    const ordinary = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "HTTP_PROXY", "NPM_CONFIG_CACHE"];
    for (const key of ordinary) expect(isAgentVisibleEnvKey(key)).toBe(true);
  });

  it("hides every PI_WEB_* daemon configuration key, including future ones", () => {
    const daemonKeys = [
      "PI_WEB_DATA_DIR",
      "PI_WEB_CONFIG",
      "PI_WEB_SESSIOND_SOCKET",
      "PI_WEB_SESSIOND_PORT",
      "PI_WEB_SESSIOND_HOST",
      "PI_WEB_SESSIOND_URL",
      "PI_WEB_HOST",
      "PI_WEB_PORT",
      "PI_WEB_ALLOWED_HOSTS",
      "PI_WEB_MAX_UPLOAD_BYTES",
      "PI_WEB_AGENT_COMMAND",
      "PI_WEB_AGENT_DIR",
      "PI_WEB_AGENT_SESSION_DIR",
      "PI_WEB_SPAWN_SESSIONS",
      "PI_WEB_SUBSESSIONS",
      "PI_WEB_ASK_USER",
      "PI_WEB_OFFLINE",
      "PI_WEB_PROJECTS_FILE",
      "PI_WEB_MACHINES_FILE",
      // The prefix rule, not a list of known keys, is what keeps future
      // daemon configuration from leaking into agent processes.
      "PI_WEB_WHATEVER_COMES_NEXT",
    ];
    for (const key of daemonKeys) expect(isAgentVisibleEnvKey(key)).toBe(false);
  });

  it("keeps deployment descriptors that agent-facing tools read", () => {
    const agentFacing = [
      "PI_WEB_DOCKER_MODE",
      "PI_WEB_DOCKER_RUNTIME",
      "PI_WEB_DOCKER_INSTALL_DIR",
      "PI_WEB_DOCKER_HELPER_IMAGE",
      "HOSTEXEC_MODE",
      "HOSTEXEC_IMAGE",
      // Agents running the `pi` CLI need the profile's auth and models.
      "PI_CODING_AGENT_DIR",
      "PI_OFFLINE",
    ];
    for (const key of agentFacing) expect(isAgentVisibleEnvKey(key)).toBe(true);
  });

  it("hides app runtime keys that distort development tooling", () => {
    // NODE_ENV=production makes npm omit devDependencies and flips Node
    // package-export conditions; PORT is the web/API's listener config.
    expect(isAgentVisibleEnvKey("NODE_ENV")).toBe(false);
    expect(isAgentVisibleEnvKey("PORT")).toBe(false);
    // Daemon session-discovery wiring; agent-run `pi` CLIs must not write
    // sessions into daemon-managed storage.
    expect(isAgentVisibleEnvKey("PI_CODING_AGENT_SESSION_DIR")).toBe(false);
  });

  it("hides every current and future OTEL_* setting from agent children", () => {
    const telemetryKeys = [
      "OTEL_ENABLED",
      "OTEL_SERVICE_NAME",
      "OTEL_RESOURCE_ATTRIBUTES",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
      "OTEL_PROPAGATORS",
      "OTEL_BSP_MAX_QUEUE_SIZE",
      "OTEL_FUTURE_SENSITIVE_SETTING",
    ];
    for (const key of telemetryKeys) expect(isAgentVisibleEnvKey(key)).toBe(false);
  });

  it("removes hidden keys from the environment and reports them sorted", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/data/home",
      NODE_ENV: "production",
      PORT: "8504",
      PI_WEB_DATA_DIR: "/data/pi-web",
      PI_WEB_SESSIOND_SOCKET: "/data/pi-web/sessiond.sock",
      PI_WEB_DOCKER_MODE: "runtime",
      HOSTEXEC_MODE: "nsenter",
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=private",
    };

    const scrubbed = scrubNonAgentVisibleEnvKeys(env);

    expect(scrubbed).toEqual(["NODE_ENV", "OTEL_ENABLED", "OTEL_EXPORTER_OTLP_HEADERS", "PI_WEB_DATA_DIR", "PI_WEB_SESSIOND_SOCKET", "PORT"]);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/data/home",
      PI_WEB_DOCKER_MODE: "runtime",
      HOSTEXEC_MODE: "nsenter",
    });
  });
});
