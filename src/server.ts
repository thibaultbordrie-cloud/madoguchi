// The MCP server: read-only tools over the Tsunagu warehouse, the Koyomi calendar and the Kensa auditor.

import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AuditLog } from "./audit.js";
import type { Config } from "./config.js";
import { emailLift } from "./lift.js";
import { buildMetricQuery, DIMENSIONS, METRICS } from "./metrics.js";
import {
  checkAuditUrl,
  kensaAudit,
  koyomiEvents,
  koyomiLunar,
  LUNAR_CALENDARS,
  MARKETS,
} from "./tools-external.js";
import type { Warehouse } from "./warehouse.js";

export const VERSION = "0.1.0";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const ShopMarket = z.enum(["FR", "JP", "TW"]);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
});
/** Error messages go to the agent: keep local paths out of them. */
const redact = (m: string) =>
  [[os.tmpdir(), "<tmp>"], [process.cwd(), "<cwd>"], [os.homedir(), "~"]].reduce(
    (acc, [dir, name]) => (dir && dir.length > 3 ? acc.split(dir).join(name) : acc),
    m,
  );
const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });

export async function createServer(cfg: Config, wh: Warehouse): Promise<McpServer> {
  const server = new McpServer(
    { name: "madoguchi", version: VERSION },
    { instructions: INSTRUCTIONS + (cfg.koyomi ? "" : "\nThe calendar tools are not configured.") + (cfg.kensa ? "" : "\nThe SEO audit tool is not configured.") },
  );
  const audit = new AuditLog(cfg.auditLog);

  /** Wraps a handler: audit log, and errors returned to the agent instead of thrown. */
  function guarded<A>(tool: string, fn: (args: A) => Promise<{ result: unknown; rows?: number }>) {
    return async (args: A): Promise<CallToolResult> => {
      const t0 = Date.now();
      try {
        const { result, rows } = await fn(args);
        audit.write({ at: new Date().toISOString(), tool, args, ok: true, ms: Date.now() - t0, rows });
        return text(result);
      } catch (e) {
        const message = redact((e as Error).message.split("\n")[0] ?? "error");
        audit.write({ at: new Date().toISOString(), tool, args, ok: false, ms: Date.now() - t0, error: message });
        return failure(message);
      }
    };
  }

  const overview = await dataOverview(wh);

  server.registerTool(
    "describe_data",
    {
      title: "Describe the data",
      description:
        "Start here. What the CRM warehouse holds (period, markets, tables and columns), the metric catalogue with one definition per metric, and what was removed for privacy.",
      inputSchema: { columns: z.boolean().default(false).describe("also list every column of every table") },
      annotations: READ_ONLY,
    },
    guarded("describe_data", async ({ columns }: { columns: boolean }) => ({ result: describe(wh, overview, columns) })),
  );

  server.registerTool(
    "query_metric",
    {
      title: "Query metrics",
      description:
        "Get metrics from the catalogue, optionally split by dimensions and filtered. Order metrics: " +
        Object.keys(METRICS).filter((m) => METRICS[m]!.family === "orders").join(", ") +
        " (split by " + Object.keys(DIMENSIONS.orders).join(", ") + "). Campaign metrics: " +
        Object.keys(METRICS).filter((m) => METRICS[m]!.family === "campaigns").join(", ") +
        " (split by " + Object.keys(DIMENSIONS.campaigns).join(", ") + "). Rates are in percent. Prefer this tool to run_sql.",
      inputSchema: {
        metrics: z.array(z.string()).min(1).max(8),
        by: z.array(z.string()).max(3).optional(),
        markets: z.array(ShopMarket).optional(),
        date_from: Day.optional().describe("first day included (order date, or send date for campaigns), local time"),
        date_to: Day.optional().describe("last day included"),
        channel: z.enum(["email", "line"]).optional().describe("campaign metrics only"),
      },
      annotations: READ_ONLY,
    },
    guarded("query_metric", async (req: Parameters<typeof buildMetricQuery>[0]) => {
      const { sql, values } = buildMetricQuery(req);
      const rows = await wh.query(sql, values);
      return { result: { rows, definitions: Object.fromEntries(req.metrics.map((m) => [m, METRICS[m]!.definition])) }, rows: rows.length };
    }),
  );

  server.registerTool(
    "run_sql",
    {
      title: "Run a read-only SQL query",
      description:
        `One DuckDB SELECT over the warehouse (schemas mart, ref, raw_shop, raw_email, raw_line, raw_crm). ` +
        `At most ${cfg.limits.rows} rows are returned and the query stops after ${cfg.limits.timeoutSeconds} s. ` +
        "Use it when no catalogue metric answers the question; say which definition you used.",
      inputSchema: { sql: z.string().min(1).max(20000) },
      annotations: READ_ONLY,
    },
    guarded("run_sql", async ({ sql }: { sql: string }) => {
      const r = await wh.select(sql);
      return { result: r, rows: r.rows.length };
    }),
  );

  server.registerTool(
    "campaign_lift",
    {
      title: "Measure what e-mail campaigns really caused",
      description:
        "Compares people who received e-mail campaigns with the holdout group deliberately not sent the same campaigns. " +
        "Returns the uplift with a 95% interval, the estimated incremental orders, and the orders last-click attribution credits, for contrast. " +
        "E-mail only: LINE does not expose who received a message.",
      inputSchema: {
        market: ShopMarket.optional(),
        campaign_id: z.number().int().positive().optional(),
        date_from: Day.optional().describe("first send day included"),
        date_to: Day.optional().describe("last send day included"),
        window_days: z.number().int().min(1).max(14).default(3).describe("days after the send during which an order counts"),
        channel: z.enum(["email", "line"]).default("email"),
      },
      annotations: READ_ONLY,
    },
    guarded("campaign_lift", async (req: { channel: string } & Parameters<typeof emailLift>[1]) => {
      if (req.channel === "line") {
        throw new Error(
          "the LINE Messaging API gives aggregates per message, not who received it, so recipients cannot be compared with the holdout group. Only e-mail can be measured this way.",
        );
      }
      return { result: await emailLift(wh, req) };
    }),
  );

  if (cfg.koyomi) {
    const bin = cfg.koyomi.binary;
    server.registerTool(
      "calendar_events",
      {
        title: "Commercial calendar",
        description:
          "Commercial and cultural dates of Japan (jp), Taiwan (tw), South Korea (kr) and France (fr), computed by Koyomi from astronomy: " +
          "lunar new year, mid-autumn, solar terms, gift seasons, sales. start and end are both included. " +
          "uncertain=true means the date depends on an instant a few seconds from midnight.",
        inputSchema: {
          markets: z.array(z.enum(MARKETS)).min(1).max(4),
          date_from: Day,
          date_to: Day,
        },
        annotations: READ_ONLY,
      },
      guarded("calendar_events", async ({ markets, date_from, date_to }: { markets: string[]; date_from: string; date_to: string }) => {
        const events = await koyomiEvents(bin, markets, date_from, date_to);
        return { result: { events }, rows: events.length };
      }),
    );
    server.registerTool(
      "lunar_date",
      {
        title: "Date in a lunisolar calendar",
        description: "Converts a Gregorian date to the Chinese, Japanese, Korean or Vietnamese lunisolar calendar (Koyomi).",
        inputSchema: { date: Day, calendar: z.enum(LUNAR_CALENDARS).default("chinese") },
        annotations: READ_ONLY,
      },
      guarded("lunar_date", async ({ date, calendar }: { date: string; calendar: string }) => ({ result: await koyomiLunar(bin, date, calendar) })),
    );
  }

  if (cfg.kensa) {
    const k = cfg.kensa;
    server.registerTool(
      "seo_audit",
      {
        title: "Multilingual SEO audit",
        description:
          "Crawls a site with Kensa and reports multilingual and AI-search SEO problems (hreflang, language, CJK titles, robots.txt for AI crawlers...). " +
          `Only these hosts may be audited: ${k.allowedHosts.join(", ")}. Takes up to a few minutes.`,
        inputSchema: { url: z.string().url(), max_pages: z.number().int().min(1).max(k.maxPages).default(Math.min(100, k.maxPages)) },
        annotations: { ...READ_ONLY, openWorldHint: true, idempotentHint: false },
      },
      guarded("seo_audit", async ({ url, max_pages }: { url: string; max_pages: number }) => {
        const r = await kensaAudit(k.binary, checkAuditUrl(url, k.allowedHosts), max_pages);
        const bySeverity: Record<string, number> = {};
        for (const f of r.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
        return { result: { origin: r.origin, pages: r.pages, by_severity: bySeverity, findings: r.findings.slice(0, 150), truncated: r.findings.length > 150 }, rows: r.findings.length };
      }),
    );
  }

  server.registerResource(
    "catalogue",
    "madoguchi://catalogue",
    { title: "Metric catalogue", description: "Every metric with its one definition", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: catalogueMarkdown() }] }),
  );

  server.registerPrompt(
    "weekly_brief",
    {
      title: "Weekly CRM brief",
      description: "A short brief for one market: sales, campaigns, what really worked, what is coming in the calendar.",
      argsSchema: { market: ShopMarket, week_start: Day },
    },
    ({ market, week_start }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Write a CRM brief for market ${market}, for the 7 days starting ${week_start}, in at most 12 lines. ` +
              "1. Orders, gross revenue in EUR and average basket vs the previous 7 days (query_metric). " +
              "2. Campaigns sent and their open rate without MPP and click rate (query_metric). " +
              "3. What the holdout says about e-mail over the last 30 days (campaign_lift); never present last-click as an effect. " +
              (cfg.koyomi ? "4. Commercial dates in the next 30 days (calendar_events). " : "") +
              "Give every number with its source tool, and say plainly when the data cannot answer.",
          },
        },
      ],
    }),
  );

  return server;
}

const INSTRUCTIONS = `Madoguchi (窓口, "the service window") gives read-only access to the CRM data of Lune & Lin, a fictional brand selling in France, Japan and Taiwan (generated by Tsunagu).
Call describe_data first. Prefer query_metric: each metric has one definition. Use campaign_lift for any question about what campaigns caused: last-click attribution (utm_order_share) is not an effect.
Personal data is not available: names are removed and e-mail addresses and LINE ids are replaced by pseudonyms. If a question needs data that is not there, say so instead of guessing.`;

interface Overview {
  first_order: string;
  last_order: string;
  markets: string[];
}

async function dataOverview(wh: Warehouse): Promise<Overview> {
  const [r] = await wh.query(
    "SELECT CAST(min(order_date) AS VARCHAR) AS a, CAST(max(order_date) AS VARCHAR) AS b, list(DISTINCT market ORDER BY market) AS m FROM mart.orders",
  );
  return { first_order: String(r?.a), last_order: String(r?.b), markets: (r?.m as string[]) ?? [] };
}

function describe(wh: Warehouse, o: Overview, columns: boolean) {
  return {
    brand: "Lune & Lin, fictional linen stationery, tea and home goods sold online in France (FR), Japan (JP) and Taiwan (TW)",
    period: { first_order: o.first_order, last_order: o.last_order, dates: "order dates are local to each market" },
    markets: o.markets,
    channels: { FR: "email", JP: "email and LINE", TW: "email and LINE" },
    currencies: "orders are in EUR, JPY or TWD; *_eur metrics convert at the fixed rates of ref.fx (1 EUR = 160 JPY = 35 TWD)",
    metrics: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, `${m.unit} · ${m.definition}`])),
    dimensions: Object.fromEntries(Object.entries(DIMENSIONS).map(([k, d]) => [k, Object.keys(d)])),
    tables: wh.tables.map((t) =>
      columns ? { table: `${t.schema}.${t.table}`, columns: t.columns.map((c) => `${c.name} ${c.type}`) } : `${t.schema}.${t.table}`,
    ),
    privacy:
      "first and last names are removed; e-mail addresses (normalised to lower case) and LINE user ids are replaced by pseudonyms (p_..., u_...) that only join within this session. The answer key of the simulation is not available.",
    limits: wh.limits,
  };
}

export function catalogueMarkdown(): string {
  const lines = ["# Metric catalogue", "", "| Metric | Family | Unit | Definition |", "|---|---|---|---|"];
  for (const [k, m] of Object.entries(METRICS)) lines.push(`| \`${k}\` | ${m.family} | ${m.unit} | ${m.definition} |`);
  lines.push("", "| Family | Dimensions |", "|---|---|");
  for (const [k, d] of Object.entries(DIMENSIONS)) lines.push(`| ${k} | ${Object.keys(d).map((x) => `\`${x}\``).join(", ")} |`);
  return lines.join("\n") + "\n";
}
