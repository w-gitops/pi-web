export interface NodeTelemetryHandle {
  readonly enabled: boolean;
  readonly serviceName: "pi-web-server" | "pi-web-sessiond";
  shutdown(): Promise<void>;
}
