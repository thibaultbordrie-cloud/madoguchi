// The metric catalogue: every number an agent can ask for has exactly one definition, here.
// Queries are assembled only from the names below; filter values are bound as parameters.

import type { DuckDBValue } from "@duckdb/node-api";

export type Family = "orders" | "campaigns";

export interface Metric {
  family: Family;
  unit: "count" | "EUR" | "%";
  sql: string;
  definition: string;
}

export const METRICS: Record<string, Metric> = {
  orders: { family: "orders", unit: "count", sql: "count(*)", definition: "Number of orders, refunded ones included." },
  buyers: { family: "orders", unit: "count", sql: "count(DISTINCT customer_id)", definition: "Distinct shop customers with at least one order." },
  gross_revenue_eur: {
    family: "orders", unit: "EUR", sql: "sum(total_eur)",
    definition: "Sum of order totals (discounts deducted, shipping included, refunds not deducted), converted to EUR at the fixed rates of ref.fx.",
  },
  avg_basket_eur: { family: "orders", unit: "EUR", sql: "avg(total_eur)", definition: "gross_revenue_eur / orders." },
  utm_order_share: {
    family: "orders", unit: "%", sql: "100.0 * avg(CAST(utm_campaign IS NOT NULL AS INTEGER))",
    definition: "Share of orders whose landing URL carries a campaign UTM: what last-click attribution credits to campaigns. It is not the share of orders campaigns caused.",
  },
  discount_order_share: {
    family: "orders", unit: "%", sql: "100.0 * avg(CAST(discount_code IS NOT NULL AS INTEGER))",
    definition: "Share of orders that used a discount code.",
  },
  campaigns: { family: "campaigns", unit: "count", sql: "count(*)", definition: "Number of campaigns sent." },
  delivered: { family: "campaigns", unit: "count", sql: "sum(delivered)", definition: "Messages delivered (e-mail: delivered; LINE: delivered)." },
  open_rate: {
    family: "campaigns", unit: "%", sql: "100.0 * sum(opens) / sum(delivered)",
    definition: "Opens / delivered, as the tools report them. E-mail opens include Apple Mail Privacy Protection machine opens; LINE counts unique impressions.",
  },
  open_rate_without_mpp: {
    family: "campaigns", unit: "%", sql: "100.0 * sum(opens_without_mpp) / sum(delivered)",
    definition: "Opens / delivered without the machine opens of Apple Mail Privacy Protection. Same as open_rate for LINE.",
  },
  click_rate: {
    family: "campaigns", unit: "%", sql: "100.0 * sum(clickers) / sum(delivered)",
    definition: "People who clicked at least once / delivered (e-mail: clickers; LINE: unique clicks).",
  },
  unsubscribe_rate: {
    family: "campaigns", unit: "%", sql: "100.0 * sum(unsubscribes) / sum(delivered) FILTER (WHERE channel = 'email')",
    definition: "Unsubscriptions / delivered, e-mail only: LINE reports blocks per account, not per message.",
  },
};

export const DIMENSIONS: Record<Family, Record<string, string>> = {
  orders: { market: "market", month: "strftime(order_date, '%Y-%m')", utm_source: "utm_source" },
  campaigns: { market: "market", month: "strftime(send_date, '%Y-%m')", channel: "channel", theme: "theme" },
};

const SOURCE: Record<Family, { view: string; date: string }> = {
  orders: { view: "mart.orders", date: "order_date" },
  campaigns: { view: "mart.campaigns", date: "send_date" },
};

export interface MetricRequest {
  metrics: string[];
  by?: string[];
  markets?: string[];
  date_from?: string;
  date_to?: string;
  channel?: "email" | "line";
}

export class MetricError extends Error {
  override name = "MetricError";
}

/** Builds the SQL for a metric request. Throws MetricError with a message written for the agent. */
export function buildMetricQuery(req: MetricRequest): { sql: string; values: DuckDBValue[] } {
  if (req.metrics.length === 0) throw new MetricError("ask for at least one metric");
  const unknown = req.metrics.filter((m) => !METRICS[m]);
  if (unknown.length) throw new MetricError(`unknown metric(s): ${unknown.join(", ")}. Known: ${Object.keys(METRICS).join(", ")}`);
  const families = new Set(req.metrics.map((m) => METRICS[m]!.family));
  if (families.size > 1) throw new MetricError("order metrics and campaign metrics come from different tables: ask for them in two calls");
  const family = [...families][0]!;
  const dims = DIMENSIONS[family];
  const by = req.by ?? [];
  const badDims = by.filter((d) => !dims[d]);
  if (badDims.length) throw new MetricError(`cannot split ${family} metrics by ${badDims.join(", ")}. Allowed: ${Object.keys(dims).join(", ")}`);
  if (req.channel && family !== "campaigns") throw new MetricError("channel only applies to campaign metrics; for orders use by: [utm_source]");

  const where: string[] = [];
  const values: DuckDBValue[] = [];
  const bind = (v: DuckDBValue) => {
    values.push(v);
    return `$${values.length}`;
  };
  if (req.markets?.length) where.push(`market IN (${req.markets.map((m) => bind(m.toUpperCase())).join(", ")})`);
  if (req.date_from) where.push(`${SOURCE[family].date} >= CAST(${bind(req.date_from)} AS DATE)`);
  if (req.date_to) where.push(`${SOURCE[family].date} <= CAST(${bind(req.date_to)} AS DATE)`);
  if (req.channel) where.push(`channel = ${bind(req.channel)}`);

  const select = [
    ...by.map((d) => `${dims[d]} AS ${d}`),
    ...req.metrics.map((m) => `round(CAST(${METRICS[m]!.sql} AS DOUBLE), 4) AS ${m}`),
  ];
  const sql =
    `SELECT ${select.join(", ")} FROM ${SOURCE[family].view}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    (by.length ? ` GROUP BY ${by.map((_, i) => i + 1).join(", ")} ORDER BY ${by.map((_, i) => i + 1).join(", ")}` : "");
  return { sql, values };
}
