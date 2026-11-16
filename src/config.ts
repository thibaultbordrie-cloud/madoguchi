// Configuration: one JSON file, checked before anything starts. Every path is resolved against the
// folder of the configuration file, so the same file works from Claude Desktop, a terminal or CI.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const Host = z.string().regex(/^[a-z0-9.-]+$/i, "a host name, without scheme or port");

const Schema = z
  .object({
    tsunagu: z.object({ database: z.string().min(1) }).strict(),
    koyomi: z.object({ binary: z.string().min(1) }).strict().optional(),
    kensa: z
      .object({
        binary: z.string().min(1),
        // Kensa crawls the web. Only these hosts may be audited; the default is this computer only.
        allowedHosts: z.array(Host).min(1).default(["127.0.0.1", "localhost"]),
        maxPages: z.number().int().min(1).max(500).default(200),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        rows: z.number().int().min(1).max(5000).default(200),
        timeoutSeconds: z.number().min(1).max(120).default(15),
      })
      .strict()
      .default({ rows: 200, timeoutSeconds: 15 }),
    // Where every tool call is logged, one JSON line each; null turns the log off.
    auditLog: z.string().nullable().default(path.join(os.homedir(), ".madoguchi", "audit.jsonl")),
  })
  .strict();

export type Config = z.infer<typeof Schema>;

/** Parses a configuration object; relative paths are resolved against `baseDir`. */
export function parseConfig(raw: unknown, baseDir: string): Config {
  const cfg = Schema.parse(raw);
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));
  cfg.tsunagu.database = abs(cfg.tsunagu.database);
  if (cfg.koyomi) cfg.koyomi.binary = abs(cfg.koyomi.binary);
  if (cfg.kensa) cfg.kensa.binary = abs(cfg.kensa.binary);
  if (cfg.auditLog) cfg.auditLog = abs(cfg.auditLog);
  if (!fs.existsSync(cfg.tsunagu.database)) {
    throw new Error(`Tsunagu database not found: ${cfg.tsunagu.database} (run: tsunagu generate)`);
  }
  for (const [name, bin] of [["koyomi", cfg.koyomi?.binary], ["kensa", cfg.kensa?.binary]] as const) {
    if (bin && !fs.existsSync(bin)) throw new Error(`${name} binary not found: ${bin}`);
  }
  return cfg;
}

export function loadConfig(file: string): Config {
  const text = fs.readFileSync(file, "utf8");
  return parseConfig(JSON.parse(text), path.dirname(path.resolve(file)));
}
