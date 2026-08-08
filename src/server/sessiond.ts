#!/usr/bin/env node
import { startNodeTelemetry } from "../telemetry/nodeTelemetry.js";

const telemetry = await startNodeTelemetry("pi-web-sessiond");
const { runSessiondMain } = await import("./sessiondMain.js");
await runSessiondMain({ telemetry });
