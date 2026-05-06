import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DcpConfig } from "./config.js";

export class Logger {
  private readonly dir: string;

  constructor(cwd: string, private readonly config: DcpConfig) {
    this.dir = join(cwd, ".pi", "dcp", "logs");
  }

  debug(message: string, data?: unknown) {
    if (!this.config.debug) return;
    this.write("debug.log", message, data);
  }

  payload(payload: unknown) {
    if (!this.config.logProviderPayloads) return;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `provider-${Date.now()}.json`), JSON.stringify(payload, null, 2), "utf8");
  }

  private write(file: string, message: string, data?: unknown) {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, file), `${new Date().toISOString()} ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`, "utf8");
  }
}
