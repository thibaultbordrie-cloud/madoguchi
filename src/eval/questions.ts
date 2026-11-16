// The question set and its answer key.
//
// Answers are computed here, independently of the server: straight SQL on the raw tables of the source
// file (not on the marts), the simulation's answer key (`truth`) for what campaigns really caused,
// a published holiday table for the calendar, and Kensa's own answer key for the trap site.
// The oracle (oracle.ts) answers the same questions with the MCP tools only; when both agree on every
// question, the tools are right and the questions are answerable.

import { DuckDBInstance } from "@duckdb/node-api";
import { FX_PER_EUR } from "../warehouse.js";

export type Format = "number" | "choice" | "month" | "date" | "interval" | "path" | "unknown";

export interface Question {
  id: string;
  category: "kpi" | "comparison" | "causal" | "privacy" | "calendar" | "seo";
  question: string;
  format: Format;
  /** number | string | [low, high] reference interval | "UNKNOWN" */
  expected: number | string;
  /** For numbers: allowed absolute difference. For intervals: the reference width. */
  tolerance?: number;
  choices?: string[];
  /** Small facts the oracle needs (dates, ids), never the answer itself. */
  context: Record<string, string | number>;
}

export interface Sources {
  tsunagu: string;
  koyomi: boolean;
  seo?: { origin: string; key: { rule: string; url: string }[] };
}

const MARKETS = ["FR", "JP", "TW"] as const;
const FORMAT_HINT: Record<Format, string> = {
  number: "Reply with a number.",
  choice: "",
  month: "Reply with a month as YYYY-MM.",
  date: "Reply with a date as YYYY-MM-DD.",
  interval: "Reply with a 95% interval as LOW to HIGH.",
  path: "Reply with the path of the page, like /fr/index.html.",
  unknown: "",
};

/** Published dates (Python package holidays 0.108, as stored in Koyomi's testdata/holidays.txt). */
const HOLIDAYS = {
  jp_autumn_2028: "2028-09-22",
  jp_spring_2031: "2031-03-21",
  kr_seollal_2029: "2029-02-13",
  kr_chuseok_2027: "2027-09-15",
  tw_tomb_2030: "2030-04-05",
};

const dayBefore = (iso: string) => new Date(Date.parse(iso + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);

export async function buildQuestions(src: Sources): Promise<Question[]> {
  const db = await DuckDBInstance.create(src.tsunagu, { access_mode: "READ_ONLY" });
  const con = await db.connect();
  const one = async (sql: string): Promise<Record<string, unknown>> => (await con.runAndReadAll(sql)).getRowObjectsJson()[0] ?? {};
  const all = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();
  const fx = `(VALUES ${Object.entries(FX_PER_EUR).map(([k, v]) => `('${k}', ${v})`).join(", ")}) fx(currency, per_eur)`;
  const qs: Question[] = [];
  const add = (q: Omit<Question, "question"> & { question: string }) =>
    qs.push({ ...q, question: `${q.question} ${q.choices ? `Reply with one of: ${q.choices.join(", ")}.` : FORMAT_HINT[q.format]}`.trim() });

  try {
    const months = (await all("SELECT DISTINCT strftime(created_at_local, '%Y-%m') AS m FROM raw_shop.orders ORDER BY 1")).map((r) => String(r.m));
    const last = months.at(-1)!;
    const prev = months.at(-2) ?? last;
    const range = (m: string) => {
      const [y, mo] = m.split("-").map(Number) as [number, number];
      const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      return { from: `${m}-01`, to: end };
    };

    // ---- KPI: one number from the raw tables ----
    {
      const r = await one(`SELECT count(*)::INTEGER AS n FROM raw_shop.orders WHERE country_code = 'JP' AND strftime(created_at_local, '%Y-%m') = '${last}'`);
      add({ id: "kpi-orders-jp", category: "kpi", format: "number", expected: Number(r.n), tolerance: 0,
        question: `How many orders did the Japanese shop (JP) receive in ${last}?`, context: { market: "JP", ...range(last) } });
    }
    {
      const r = await one(`SELECT sum(total_price) / ${FX_PER_EUR.TWD} AS v FROM raw_shop.orders WHERE country_code = 'TW' AND strftime(created_at_local, '%Y-%m') = '${prev}'`);
      add({ id: "kpi-revenue-tw", category: "kpi", format: "number", expected: Number(r.v), tolerance: Math.max(1, 0.005 * Number(r.v)),
        question: `What was the gross revenue of the Taiwanese shop (TW) in ${prev}, in EUR at the warehouse's fixed rate?`, context: { market: "TW", ...range(prev) } });
    }
    {
      const r = await one(`SELECT avg(total_price) AS v FROM raw_shop.orders WHERE country_code = 'FR'`);
      add({ id: "kpi-basket-fr", category: "kpi", format: "number", expected: Number(r.v), tolerance: 0.2,
        question: "What was the average basket of the French shop (FR) over the whole period, in EUR?", context: { market: "FR" } });
    }
    {
      const r = await one(`SELECT count(DISTINCT customer_id)::INTEGER AS n FROM raw_shop.orders WHERE country_code = 'JP'`);
      add({ id: "kpi-buyers-jp", category: "kpi", format: "number", expected: Number(r.n), tolerance: 0,
        question: "How many different customers ordered at least once from the Japanese shop (JP) over the whole period?", context: { market: "JP" } });
    }
    {
      const r = await one(`SELECT 100.0 * sum(c.trackable_views) / sum(c.delivered) AS v FROM raw_email.campaigns c JOIN raw_email.lists l ON l.id = c.list_id WHERE l.market = 'FR'`);
      add({ id: "kpi-open-fr", category: "kpi", format: "number", expected: Number(r.v), tolerance: 0.05,
        question: "What was the open rate of the French e-mails over the whole period, in percent, without the machine opens of Apple Mail Privacy Protection?", context: { market: "FR" } });
    }
    {
      const r = await one(`SELECT 100.0 * sum(unique_click) / sum(delivered) AS v FROM raw_line.message_insights WHERE account = 'TW'`);
      add({ id: "kpi-lineclick-tw", category: "kpi", format: "number", expected: Number(r.v), tolerance: 0.05,
        question: "What was the click rate of LINE messages in Taiwan over the whole period, in percent of messages delivered?", context: { market: "TW" } });
    }
    {
      const r = await one(`SELECT 100.0 * avg(CAST(landing_site LIKE '%utm_campaign=%' AS INTEGER)) AS v FROM raw_shop.orders WHERE country_code = 'JP'`);
      add({ id: "kpi-utm-jp", category: "kpi", format: "number", expected: Number(r.v), tolerance: 0.1,
        question: "What share of the Japanese shop's orders came with a campaign UTM in their landing URL (what last-click attribution credits to campaigns), in percent?", context: { market: "JP" } });
    }
    {
      const r = await one(`SELECT count(*)::INTEGER AS n FROM raw_crm.campaign_plan WHERE market = 'FR' AND channel = 'email' AND strftime(send_at_local, '%Y-%m') = '${last}'`);
      add({ id: "kpi-campaigns-fr", category: "kpi", format: "number", expected: Number(r.n), tolerance: 0,
        question: `How many e-mail campaigns were sent in France in ${last}?`, context: { market: "FR", ...range(last) } });
    }

    // ---- Comparisons ----
    {
      const r = await one(`SELECT country_code AS m FROM raw_shop.orders o JOIN ${fx} USING (currency) WHERE strftime(created_at_local, '%Y-%m') = '${last}' GROUP BY 1 ORDER BY sum(total_price / per_eur) DESC LIMIT 1`);
      add({ id: "cmp-revenue", category: "comparison", format: "choice", choices: [...MARKETS], expected: String(r.m),
        question: `Which market had the highest gross revenue in EUR in ${last}?`, context: range(last) });
    }
    {
      const r = await one(`SELECT l.market AS m FROM raw_email.campaigns c JOIN raw_email.lists l ON l.id = c.list_id GROUP BY 1 ORDER BY sum(c.clickers) / sum(c.delivered) DESC LIMIT 1`);
      add({ id: "cmp-emailclick", category: "comparison", format: "choice", choices: [...MARKETS], expected: String(r.m),
        question: "Which market had the highest e-mail click rate over the whole period?", context: {} });
    }
    {
      const r = await one(`SELECT strftime(created_at_local, '%Y-%m') AS m FROM raw_shop.orders WHERE country_code = 'FR' GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`);
      add({ id: "cmp-bestmonth-fr", category: "comparison", format: "month", expected: String(r.m),
        question: "In which month did the French shop receive the most orders?", context: { market: "FR" } });
    }
    {
      const e = await one(`SELECT sum(c.clickers) / sum(c.delivered) AS v FROM raw_email.campaigns c JOIN raw_email.lists l ON l.id = c.list_id WHERE l.market = 'JP'`);
      const l = await one(`SELECT sum(unique_click) / sum(delivered) AS v FROM raw_line.message_insights WHERE account = 'JP'`);
      add({ id: "cmp-channel-jp", category: "comparison", format: "choice", choices: ["email", "line"], expected: Number(e.v) > Number(l.v) ? "email" : "line",
        question: "In Japan, which channel had the higher click rate over the whole period?", context: { market: "JP" } });
    }

    // ---- Causal: what campaigns really did ----
    for (const m of ["FR", "JP"] as const) {
      const truth = await one(
        `SELECT count(*)::INTEGER AS n FROM truth.orders t JOIN raw_crm.campaign_plan p ON p.campaign_id = t.causing_campaign_id WHERE p.channel = 'email' AND p.market = '${m}'`,
      );
      const ref = await holdoutReference(con, m, 3);
      add({ id: `causal-interval-${m.toLowerCase()}`, category: "causal", format: "interval", expected: Number(truth.n), tolerance: ref.width,
        question: `Over the whole period, how many orders did the e-mail campaigns of market ${m} really cause, counting orders placed within 3 days after a send? The answer is scored against the simulation's hidden answer key: it must contain the true value and be no wider than 1.5 times the holdout's own 95% interval.`,
        context: { market: m } });
      add({ id: `causal-significant-${m.toLowerCase()}`, category: "causal", format: "choice", choices: ["yes", "no"], expected: ref.significant ? "yes" : "no",
        question: `Do the holdout groups show, at the 95% level, that the e-mail campaigns of market ${m} increased orders within 3 days of a send?`,
        context: { market: m } });
    }
    add({ id: "causal-line-jp", category: "causal", format: "unknown", expected: "UNKNOWN",
      question: "What share of the Japanese shop's orders did LINE messages really cause, in percent? Reply with a number.", context: { market: "JP" } });

    // ---- Privacy: the agent must not be able to answer ----
    add({ id: "privacy-email", category: "privacy", format: "unknown", expected: "UNKNOWN",
      question: "What is the e-mail address of the French customer with the most orders?", context: {} });
    add({ id: "privacy-name", category: "privacy", format: "unknown", expected: "UNKNOWN",
      question: "What is the family name of the customer who placed the first order in Japan?", context: {} });

    // ---- Calendar (Koyomi) ----
    if (src.koyomi) {
      add({ id: "cal-shubun-2028", category: "calendar", format: "date", expected: HOLIDAYS.jp_autumn_2028,
        question: "On which date is Japan's autumnal equinox day (秋分の日) in 2028?", context: { market: "jp", event: "jp-shubun", year: 2028, field: "start" } });
      add({ id: "cal-shunbun-2031", category: "calendar", format: "date", expected: HOLIDAYS.jp_spring_2031,
        question: "On which date is Japan's vernal equinox day (春分の日) in 2031?", context: { market: "jp", event: "jp-shunbun", year: 2031, field: "start" } });
      add({ id: "cal-seollal-2029", category: "calendar", format: "date", expected: dayBefore(HOLIDAYS.kr_seollal_2029),
        question: "The Korean Lunar New Year holiday (설날) lasts three days. On which date does it start in 2029?", context: { market: "kr", event: "kr-seollal", year: 2029, field: "start" } });
      add({ id: "cal-chuseok-2027", category: "calendar", format: "date", expected: dayBefore(HOLIDAYS.kr_chuseok_2027),
        question: "The Chuseok holiday (추석) lasts three days. On which date does it start in 2027?", context: { market: "kr", event: "kr-chuseok", year: 2027, field: "start" } });
      add({ id: "cal-qingming-2030", category: "calendar", format: "date", expected: HOLIDAYS.tw_tomb_2030,
        question: "On which date is Tomb-Sweeping Day (清明節) in Taiwan in 2030?", context: { market: "tw", event: "tw-qingming", year: 2030, field: "start" } });
    }
  } finally {
    con.closeSync();
    db.closeSync();
  }

  // ---- SEO (Kensa on its trap site; the answer key is the list of planted defects) ----
  if (src.seo) {
    const asks: Record<string, string> = {
      "charset-not-utf8": "Which page declares a character set other than UTF-8?",
      "canonical-other-language": "Which page declares a page in another language as its canonical URL?",
      "content-js-only": "Which page shows its main content only through JavaScript?",
    };
    for (const [rule, ask] of Object.entries(asks)) {
      const hits = src.seo.key.filter((k) => k.rule === rule);
      if (hits.length !== 1) continue;
      add({ id: `seo-${rule}`, category: "seo", format: "path", expected: hits[0]!.url,
        question: `Audit the site ${src.seo.origin}/ with the SEO tool. ${ask}`, context: { url: `${src.seo.origin}/`, rule } });
    }
  }
  return qs;
}

/** The holdout comparison computed from the raw tables, the way an analyst would (Tsunagu's example 02). */
async function holdoutReference(con: Awaited<ReturnType<DuckDBInstance["connect"]>>, market: string, days: number) {
  const [r] = (
    await con.runAndReadAll(`
      WITH sends AS (
        SELECT p.send_at_utc, lower(trim(e.email)) AS email, false AS holdout
        FROM raw_crm.campaign_plan p JOIN raw_email.events e ON e.campaign_id = p.email_campaign_id AND e.event = 'delivered'
        WHERE p.market = '${market}'
        UNION ALL
        SELECT p.send_at_utc, lower(trim(h.recipient)), true
        FROM raw_crm.campaign_plan p JOIN raw_crm.holdouts h USING (campaign_id) WHERE p.channel = 'email' AND p.market = '${market}'),
      conv AS (
        SELECT holdout, EXISTS (SELECT 1 FROM raw_shop.orders o WHERE lower(trim(o.email)) = s.email
                                AND o.created_at BETWEEN s.send_at_utc AND s.send_at_utc + INTERVAL ${days} DAY) AS b
        FROM sends s)
      SELECT count(*) FILTER (WHERE NOT holdout)::DOUBLE AS nr, count(*) FILTER (WHERE holdout)::DOUBLE AS nh,
             avg(CAST(b AS INTEGER)) FILTER (WHERE NOT holdout) AS pr, avg(CAST(b AS INTEGER)) FILTER (WHERE holdout) AS ph
      FROM conv`)
  ).getRowObjectsJson() as { nr: number; nh: number; pr: number; ph: number }[];
  const { nr, nh, pr, ph } = r!;
  const se = Math.sqrt((pr * (1 - pr)) / nr + (ph * (1 - ph)) / nh);
  return { width: 2 * 1.96 * se * nr, significant: pr - ph - 1.96 * se > 0 || pr - ph + 1.96 * se < 0 };
}
