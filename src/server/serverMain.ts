import { effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";
import { emitTelemetryLog } from "./telemetry/logs.js";
import type { NodeTelemetryHandle } from "./telemetry/types.js";
import { boundedProcessShutdown } from "./telemetry/processShutdown.js";

export interface ServerMainOptions {
  telemetry: NodeTelemetryHandle;
  exit?: (code: number) => never | void;
}

export async function runServerMain({ telemetry, exit = (code) => process.exit(code) }: ServerMainOptions): Promise<void> {
  const { config } = effectivePiWebConfig();
  const app = await buildApp({ bodyLimit: maxUploadBytes(process.env, config), clientTelemetry: { enabled: telemetry.enabled } });
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    emitTelemetryLog({ event: "service.stopping", component: telemetry.serviceName });
    let exitCode = 0;
    await boundedProcessShutdown(async () => {
      try {
        await app.close();
      } catch {
        exitCode = 1;
      }
      emitTelemetryLog({ event: "service.stopped", component: telemetry.serviceName });
      await telemetry.shutdown();
    });
    exit(exitCode);
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  await app.listen({ port: config.port ?? 8504, host: config.host ?? "127.0.0.1" });
  emitTelemetryLog({ event: "service.started", component: telemetry.serviceName });
}
