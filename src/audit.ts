// One JSON line per tool call: when, which tool, with which arguments, how long, how it ended.
// The log never holds results, only their size, so it cannot become a copy of the data.

import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  at: string;
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
  rows?: number;
  error?: string;
}

export class AuditLog {
  constructor(private readonly file: string | null) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  write(entry: AuditEntry): void {
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (e) {
      // The log must never break a tool call; say it on stderr (stdout belongs to the protocol).
      process.stderr.write(`madoguchi: cannot write the audit log: ${(e as Error).message}\n`);
    }
  }
}
