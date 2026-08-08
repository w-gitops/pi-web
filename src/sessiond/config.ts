import { join } from "node:path";
import { piWebDataDir } from "../config.js";

export function sessiondSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["PI_WEB_SESSIOND_SOCKET"] ?? join(piWebDataDir(env), "sessiond.sock");
}

export function sessiondHttpUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["PI_WEB_SESSIOND_URL"];
}
