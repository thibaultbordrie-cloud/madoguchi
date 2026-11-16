// Koyomi (Go) and Kensa (Rust) are called as programs: no shell, fixed arguments built from validated
// input, a time limit, a cap on output size, and an environment that carries no secret.

import { execFile } from "node:child_process";

export interface RunOptions {
  timeoutSeconds: number;
  env?: NodeJS.ProcessEnv;
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/** Only what a program needs to start; nothing from the user's environment that could be a secret. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "SSL_CERT_FILE"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

export function run(binary: string, args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: opts.timeoutSeconds * 1000, maxBuffer: MAX_OUTPUT, env: cleanEnv(opts.env), windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        if (err) {
          const why = (stderr || err.message).toString().trim().split("\n").slice(-3).join(" ");
          reject(new Error(err.killed ? `${binary} was stopped after ${opts.timeoutSeconds} s` : why));
        } else resolve(stdout.toString());
      },
    );
  });
}

// ---------- Koyomi ----------

export const MARKETS = ["jp", "tw", "kr", "fr"] as const;
export const LUNAR_CALENDARS = ["chinese", "japanese", "korean", "vietnamese"] as const;

export interface KoyomiEvent {
  id: string;
  market: string;
  start: string;
  end: string;
  name_local: string;
  name_en: string;
  name_fr: string;
  kind: string;
  basis: string;
  rule: string;
  sells: string;
  window: boolean;
  uncertain: boolean;
}

export async function koyomiEvents(binary: string, markets: string[], from: string, to: string): Promise<KoyomiEvent[]> {
  const y1 = Number(from.slice(0, 4));
  const y2 = Number(to.slice(0, 4));
  if (y2 < y1) throw new Error("date_to is before date_from");
  if (y2 - y1 > 5) throw new Error("ask for at most six calendar years at a time");
  // An event of December can end in January: read one year before so it is not missed.
  const out = await run(binary, ["events", "-market", markets.join(","), "-from", String(y1 - 1), "-to", String(y2), "-format", "json"], {
    timeoutSeconds: 30,
  });
  const events = (JSON.parse(out) as { events: KoyomiEvent[] }).events;
  return events.filter((e) => e.end >= from && e.start <= to);
}

export async function koyomiLunar(binary: string, date: string, calendar: string): Promise<string> {
  return (await run(binary, ["lunar", "-calendar", calendar, date], { timeoutSeconds: 15 })).trim();
}

// ---------- Kensa ----------

export interface KensaFinding {
  rule: string;
  severity: string;
  url: string;
  message: string;
}

/** Throws unless the URL is http(s) on an allowed host. */
export function checkAuditUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs can be audited");
  if (url.username || url.password) throw new Error("URLs with credentials are refused");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new Error(`${host} is not in the allowed hosts (${allowedHosts.join(", ")}). Ask the person running Madoguchi to add it to kensa.allowedHosts.`);
  }
  return url;
}

export async function kensaAudit(binary: string, url: URL, maxPages: number): Promise<{ origin: string; pages: number; findings: KensaFinding[] }> {
  // Loopback audits must not go through a proxy the user may have configured.
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  const env = loopback ? { NO_PROXY: "*", no_proxy: "*" } : { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
  const out = await run(binary, ["audit", url.href, "--format", "json", "--max-pages", String(maxPages), "--workers", "2"], {
    timeoutSeconds: 180,
    env,
  });
  return JSON.parse(out);
}
