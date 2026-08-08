import { captureNodeTelemetryConfig, type PiWebTelemetryServiceName } from "./config.js";
import type { NodeTelemetryHandle } from "./types.js";

export async function startNodeTelemetry(defaultServiceName: PiWebTelemetryServiceName, env: NodeJS.ProcessEnv = process.env): Promise<NodeTelemetryHandle> {
  const config = captureNodeTelemetryConfig(env, defaultServiceName);
  if (!config.enabled) return { enabled: false, serviceName: defaultServiceName, shutdown: () => Promise.resolve() };

  try {
    const { startEnabledNodeTelemetry } = await import("./nodeTelemetryEnabled.js");
    return startEnabledNodeTelemetry(config, env);
  } catch {
    // Startup is fail-open by design. Avoid serializing the caught error because
    // module/endpoint failures may themselves contain paths or credentials.
    process.stderr.write("PI WEB OpenTelemetry startup failed; continuing without telemetry.\n");
    return { enabled: false, serviceName: defaultServiceName, shutdown: () => Promise.resolve() };
  }
}
