// What the holdout groups say: the conversion of people who got an e-mail against people who were
// deliberately held out of the same campaigns. This is the honest estimate of what campaigns cause;
// last-click attribution is shown next to it for contrast.

import type { DuckDBValue } from "@duckdb/node-api";
import type { Warehouse } from "./warehouse.js";

export interface LiftRequest {
  market?: string;
  campaign_id?: number;
  date_from?: string;
  date_to?: string;
  window_days?: number;
}

export interface LiftResult {
  campaigns: number;
  window_days: number;
  recipients: number;
  holdouts: number;
  recipient_conversion_pct: number;
  holdout_conversion_pct: number;
  uplift_pts: number;
  uplift_ci95_pts: [number, number];
  incremental_orders_estimate: number;
  incremental_orders_ci95: [number, number];
  last_click_orders: number;
  significant: boolean;
  verdict: string;
  method: string;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export async function emailLift(wh: Warehouse, req: LiftRequest): Promise<LiftResult> {
  const window = req.window_days ?? 3;
  const where: string[] = [];
  const values: DuckDBValue[] = [];
  const bind = (v: DuckDBValue) => {
    values.push(v);
    return `$${values.length}`;
  };
  if (req.market) where.push(`market = ${bind(req.market.toUpperCase())}`);
  if (req.campaign_id !== undefined) where.push(`campaign_id = ${bind(req.campaign_id)}`);
  if (req.date_from) where.push(`CAST(send_at_utc AS DATE) >= CAST(${bind(req.date_from)} AS DATE)`);
  if (req.date_to) where.push(`CAST(send_at_utc AS DATE) <= CAST(${bind(req.date_to)} AS DATE)`);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const w = bind(window);

  // A send converts when the same person orders within the window after the send.
  const [row] = await wh.query(
    `WITH s AS (SELECT * FROM mart.email_sends ${filter}),
          conv AS (
            SELECT s.campaign_id, s.holdout,
                   EXISTS (SELECT 1 FROM mart.orders o WHERE o.person = s.person
                           AND o.created_at_utc BETWEEN s.send_at_utc AND s.send_at_utc + to_days(CAST(${w} AS INTEGER))) AS bought
            FROM s)
     SELECT count(DISTINCT campaign_id)::INTEGER AS campaigns,
            count(*) FILTER (WHERE NOT holdout)::INTEGER AS n_r,
            count(*) FILTER (WHERE holdout)::INTEGER AS n_h,
            coalesce(avg(CAST(bought AS INTEGER)) FILTER (WHERE NOT holdout), 0)::DOUBLE AS p_r,
            coalesce(avg(CAST(bought AS INTEGER)) FILTER (WHERE holdout), 0)::DOUBLE AS p_h,
            (SELECT count(*) FROM mart.orders o WHERE o.utm_campaign_id IN (SELECT DISTINCT campaign_id FROM s))::INTEGER AS last_click
     FROM conv`,
    values,
  );
  const campaigns = Number(row?.campaigns ?? 0);
  const nR = Number(row?.n_r ?? 0);
  const nH = Number(row?.n_h ?? 0);
  if (campaigns === 0 || nR === 0) throw new Error("no e-mail campaign matches these filters");
  if (nH === 0) throw new Error("these campaigns have no holdout group: their effect cannot be measured");
  const pR = Number(row?.p_r);
  const pH = Number(row?.p_h);
  const se = Math.sqrt((pR * (1 - pR)) / nR + (pH * (1 - pH)) / nH);
  const diff = pR - pH;
  const lo = diff - 1.96 * se;
  const hi = diff + 1.96 * se;
  const lastClick = Number(row?.last_click ?? 0);
  const significant = lo > 0 || hi < 0;
  const est = diff * nR;
  const verdict = significant
    ? `The holdout shows an effect: about ${Math.round(est)} incremental orders (95% interval ${Math.round(lo * nR)} to ${Math.round(hi * nR)}), against ${lastClick} orders credited by last-click.`
    : `The holdout cannot tell the effect from zero: the 95% interval goes from ${Math.round(lo * nR)} to ${Math.round(hi * nR)} incremental orders. Last-click credits ${lastClick} orders, which says nothing about cause.`;
  return {
    campaigns,
    window_days: window,
    recipients: nR,
    holdouts: nH,
    recipient_conversion_pct: round(100 * pR),
    holdout_conversion_pct: round(100 * pH),
    uplift_pts: round(100 * diff),
    uplift_ci95_pts: [round(100 * lo), round(100 * hi)],
    incremental_orders_estimate: round(est, 1),
    incremental_orders_ci95: [round(lo * nR, 1), round(hi * nR, 1)],
    last_click_orders: lastClick,
    significant,
    verdict,
    method:
      "Share of sends followed by an order from the same person within the window, recipients minus holdouts, " +
      "normal approximation for the 95% interval. Incremental orders = uplift x recipients.",
  };
}
