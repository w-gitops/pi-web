import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { logs } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { clientRequestIdAttributes, isClientTelemetryIntakePath, selectPrivacySafeInstrumentations, type NodeTelemetryConfig } from "./config.js";
import { configureExplicitTelemetryLogEmitter } from "./logs.js";
import { PrivacySpanExporter } from "./privacySpanExporter.js";
import { boundedTelemetryShutdown } from "./shutdown.js";
import type { NodeTelemetryHandle } from "./types.js";

export function startEnabledNodeTelemetry(config: NodeTelemetryConfig, env: NodeJS.ProcessEnv): NodeTelemetryHandle {
  const traceExporter = new PrivacySpanExporter(new OTLPTraceExporter({ timeoutMillis: config.exporterTimeoutMillis }));
  const logExporter = new OTLPLogExporter({ timeoutMillis: config.exporterTimeoutMillis });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ "service.name": env["OTEL_SERVICE_NAME"] ?? config.serviceName }),
    resourceDetectors: [envDetector],
    textMapPropagator: new W3CTraceContextPropagator(),
    spanProcessors: [new BatchSpanProcessor(traceExporter, {
      maxQueueSize: config.spanQueueSize,
      maxExportBatchSize: Math.min(128, config.spanQueueSize),
      scheduledDelayMillis: 1_000,
      exportTimeoutMillis: config.exporterTimeoutMillis,
    })],
    logRecordProcessors: [new BatchLogRecordProcessor({
      exporter: logExporter,
      maxQueueSize: config.logQueueSize,
      maxExportBatchSize: Math.min(64, config.logQueueSize),
      scheduledDelayMillis: 1_000,
      exportTimeoutMillis: config.exporterTimeoutMillis,
    })],
    instrumentations: [selectPrivacySafeInstrumentations(getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": {
        ignoreIncomingRequestHook: (request) => isClientTelemetryIntakePath(request.url),
        ignoreOutgoingRequestHook: (request) => isClientTelemetryIntakePath(request.path),
        startIncomingSpanHook: (request) => clientRequestIdAttributes(request.headers["x-pi-web-request-id"]),
      },
    }))],
  });
  sdk.start();
  const logger = logs.getLogger("pi-web.telemetry");
  configureExplicitTelemetryLogEmitter((record) => {
    logger.emit({ body: record.eventName, ...record });
  });
  return {
    enabled: true,
    serviceName: config.serviceName,
    shutdown: async () => {
      await boundedTelemetryShutdown(() => sdk.shutdown(), config.shutdownTimeoutMillis);
      configureExplicitTelemetryLogEmitter(undefined);
    },
  };
}
