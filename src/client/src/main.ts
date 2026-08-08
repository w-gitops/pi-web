import { startClientTelemetry } from "./telemetry/clientTelemetry";

// Discovery starts first so early API calls can be observed, but telemetry
// availability must never delay rendering or make the application unavailable.
void startClientTelemetry();
await import("./components/PiWebApp");
