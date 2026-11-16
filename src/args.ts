// Command-line options shared by every command.

import { loadConfig, parseConfig, type Config } from "./config.js";

export function configFromArgs(values: Record<string, unknown>): Config {
  if (typeof values.config === "string") return loadConfig(values.config);
  if (typeof process.env.MADOGUCHI_CONFIG === "string" && !values.tsunagu) return loadConfig(process.env.MADOGUCHI_CONFIG);
  if (typeof values.tsunagu !== "string") throw new Error("give --config FILE or --tsunagu DATABASE");
  const hosts = values["allow-host"] as string[] | undefined;
  return parseConfig(
    {
      tsunagu: { database: values.tsunagu },
      ...(typeof values.koyomi === "string" ? { koyomi: { binary: values.koyomi } } : {}),
      ...(typeof values.kensa === "string" ? { kensa: { binary: values.kensa, ...(hosts?.length ? { allowedHosts: hosts } : {}) } } : {}),
      ...(values["no-audit-log"] ? { auditLog: null } : {}),
    },
    process.cwd(),
  );
}

export const OPTIONS = {
  config: { type: "string" },
  tsunagu: { type: "string" },
  koyomi: { type: "string" },
  kensa: { type: "string" },
  "allow-host": { type: "string", multiple: true },
  "no-audit-log": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

