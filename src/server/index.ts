#!/usr/bin/env node
import { startNodeTelemetry } from "../telemetry/nodeTelemetry.js";

const telemetry = await startNodeTelemetry("pi-web-server");
const { runServerMain } = await import("./serverMain.js");
await runServerMain({ telemetry });
