// The governed copy of the Tsunagu warehouse that agents query.
//
// Four locks, from the outside in:
//  1. The answer key never reaches the agent: only the `ref` and `raw_*` schemas are copied, `truth` is not.
//  2. Personal data never reaches the agent: names are dropped, e-mail addresses and LINE user ids are
//     replaced by salted hashes (the salt is new at every start, so pseudonyms cannot be linked across runs).
//     A column that looks personal and has no explicit rule stops the build.
//  3. The copy is opened read-only, with file access and extensions disabled and the configuration locked:
//     no write, no ATTACH, no read_csv, no COPY, even if a query gets past the guard.
//  4. Agent SQL must parse as one SELECT, runs under a time limit and returns a bounded number of rows.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DuckDBConnection, DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";

export const SCHEMAS = ["ref", "raw_shop", "raw_email", "raw_line", "raw_crm"] as const;

/** Fixed conversion rates of the Tsunagu world (src/tsunagu/universe.py: FX_FROM_EUR). */
export const FX_PER_EUR: Record<string, number> = { EUR: 1, JPY: 160, TWD: 35 };

type Rule = "keep" | "drop" | "pseudo_email" | "pseudo_id" | "pseudo_recipient";

/** Explicit rules for every column that could identify a person. */
export const COLUMN_RULES: Record<string, Rule> = {
  "raw_shop.customers.email": "pseudo_email",
  "raw_shop.customers.first_name": "drop",
  "raw_shop.customers.last_name": "drop",
  "raw_shop.customers.last_name_kana": "drop",
  "raw_shop.orders.email": "pseudo_email",
  "raw_email.contacts.email": "pseudo_email",
  "raw_email.contacts.firstname": "drop",
  "raw_email.contacts.lastname": "drop",
  "raw_email.contacts.email_blacklisted": "keep",
  "raw_email.events.email": "pseudo_email",
  "raw_crm.holdouts.recipient": "pseudo_recipient",
  "raw_crm.campaign_plan.email_campaign_id": "keep",
  "raw_line.login_links.line_user_id": "pseudo_id",
  "raw_line.webhook_events.user_id": "pseudo_id",
};

/** Column names that look personal. Each one needs a rule above, or the build stops. */
export const LOOKS_PERSONAL = /e?mail|first_?name|last_?name|kana|phone|address|user_id|recipient|birth/i;

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface Limits {
  rows: number;
  timeoutSeconds: number;
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export class Warehouse {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly file: string,
    readonly tables: { schema: string; table: string; columns: { name: string; type: string }[] }[],
    readonly limits: Limits,
  ) {}

  /** Builds the governed copy of `source` in a temporary file and opens it locked. */
  static async open(source: string, limits: Limits): Promise<Warehouse> {
    const file = path.join(os.tmpdir(), `madoguchi-${process.pid}-${crypto.randomBytes(6).toString("hex")}.duckdb`);
    try {
      await build(source, file, crypto.randomBytes(16).toString("hex"));
    } catch (e) {
      for (const f of [file, `${file}.wal`]) fs.rmSync(f, { force: true });
      throw e;
    }
    const instance = await DuckDBInstance.create(file, {
      access_mode: "READ_ONLY",
      enable_external_access: "false",
      autoload_known_extensions: "false",
      autoinstall_known_extensions: "false",
      allow_community_extensions: "false",
      threads: "2",
      lock_configuration: "true",
    });
    const con = await instance.connect();
    try {
      const cols = await con.runAndReadAll(
        `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
         ORDER BY table_schema, table_name, ordinal_position`,
      );
      const tables: Warehouse["tables"] = [];
      for (const r of cols.getRowObjectsJson()) {
        const [schema, table] = [String(r.table_schema), String(r.table_name)];
        let t = tables.at(-1);
        if (!t || t.schema !== schema || t.table !== table) tables.push((t = { schema, table, columns: [] }));
        t.columns.push({ name: String(r.column_name), type: String(r.data_type) });
      }
      return new Warehouse(instance, file, tables, limits);
    } finally {
      con.closeSync();
    }
  }

  /** Runs trusted SQL written in this code base (parameters bound, never concatenated). */
  async query(sql: string, values?: DuckDBValue[]): Promise<Record<string, unknown>[]> {
    const con = await this.instance.connect();
    try {
      return (await withTimeout(con, this.limits.timeoutSeconds, () => con.runAndReadAll(sql, values))).getRowObjectsJson();
    } finally {
      con.closeSync();
    }
  }

  /** Runs SQL written by an agent: one SELECT, bounded in time and rows. */
  async select(sql: string, timeoutSeconds = this.limits.timeoutSeconds): Promise<QueryResult> {
    await this.assertSelect(sql);
    const con = await this.instance.connect();
    try {
      const reader = await withTimeout(con, timeoutSeconds, () =>
        con.streamAndReadUntil(sql, this.limits.rows + 1),
      );
      const names = reader.columnNames();
      // Large integers and decimals come back as strings; give the agent numbers when no precision is lost.
      const numeric = reader.columnTypes().map((t) => /^(U?BIGINT|U?HUGEINT|DECIMAL)/.test(t.toString()));
      const rows = reader.getRowObjectsJson().map((row) => {
        names.forEach((n, i) => {
          const v = row[n];
          if (numeric[i] && typeof v === "string" && Number.isSafeInteger(Math.trunc(Number(v)))) row[n] = Number(v);
        });
        return row;
      });
      return { columns: names, rows: rows.slice(0, this.limits.rows), truncated: rows.length > this.limits.rows };
    } finally {
      con.closeSync();
    }
  }

  /** Throws unless `sql` parses as exactly one SELECT statement. */
  async assertSelect(sql: string): Promise<void> {
    if (sql.length > 20_000) throw new GuardError("the query is longer than 20,000 characters");
    const [row] = await this.query("SELECT json_serialize_sql($1::VARCHAR) AS tree", [sql]);
    const tree = JSON.parse(String(row?.tree ?? "{}"));
    if (tree.error) {
      const why = String(tree.error_message ?? "not a SELECT statement");
      throw new GuardError(/only SELECT/i.test(why) ? "only SELECT statements are allowed" : why);
    }
    if (!Array.isArray(tree.statements) || tree.statements.length !== 1) {
      throw new GuardError("send exactly one statement");
    }
  }

  async close(): Promise<void> {
    this.instance.closeSync();
    for (const f of [this.file, `${this.file}.wal`]) fs.rmSync(f, { force: true });
  }
}

export class GuardError extends Error {
  override name = "GuardError";
}

async function withTimeout<T>(con: DuckDBConnection, seconds: number, run: () => Promise<T>): Promise<T> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    con.interrupt();
  }, seconds * 1000);
  try {
    return await run();
  } catch (e) {
    if (timedOut) throw new GuardError(`the query was stopped after ${seconds} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Copies the allowed schemas of `source` into `target`, applying the column rules, then adds the marts. */
async function build(source: string, target: string, salt: string): Promise<void> {
  const instance = await DuckDBInstance.create(target);
  const con = await instance.connect();
  try {
    await con.run(`ATTACH ${quoteString(source)} AS src (READ_ONLY)`);
    const cols = (
      await con.runAndReadAll(
        `SELECT schema_name AS s, table_name AS t, column_name AS c FROM duckdb_columns()
         WHERE database_name = 'src' AND schema_name IN (${SCHEMAS.map(quoteString).join(", ")})
         ORDER BY schema_name, table_name, column_index`,
      )
    ).getRowObjectsJson() as { s: string; t: string; c: string }[];
    const tables = new Map<string, string[]>();
    for (const { s, t, c } of cols) {
      const key = `${s}.${t}.${c}`;
      const rule = COLUMN_RULES[key] ?? (LOOKS_PERSONAL.test(c) ? undefined : "keep");
      if (!rule) throw new Error(`column ${key} looks personal and has no rule in COLUMN_RULES`);
      const expr = projection(c, rule, salt);
      if (!expr) continue;
      const list = tables.get(`${s}.${t}`) ?? [];
      list.push(expr);
      tables.set(`${s}.${t}`, list);
    }
    for (const s of SCHEMAS) await con.run(`CREATE SCHEMA ${s}`);
    for (const [name, exprs] of tables) {
      const [s, t] = name.split(".") as [string, string];
      await con.run(
        `CREATE TABLE ${s}.${quoteIdent(t)} AS SELECT ${exprs.join(", ")} FROM src.${s}.${quoteIdent(t)}`,
      );
    }
    await con.run("DETACH src");
    await con.run(
      `CREATE TABLE ref.fx (currency VARCHAR, per_eur DOUBLE);
       INSERT INTO ref.fx VALUES ${Object.entries(FX_PER_EUR).map(([k, v]) => `('${k}', ${v})`).join(", ")}`,
    );
    await con.run(MARTS);
    await con.run("CHECKPOINT");
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

function projection(column: string, rule: Rule, salt: string): string | null {
  const c = quoteIdent(column);
  const hash = (prefix: string, value: string) =>
    `CASE WHEN ${value} IS NULL THEN NULL ELSE '${prefix}' || left(sha256('${salt}' || ${value}), 16) END`;
  switch (rule) {
    case "keep":
      return c;
    case "drop":
      return null;
    case "pseudo_email":
      return `${hash("p_", `lower(trim(${c}))`)} AS ${c}`;
    case "pseudo_id":
      return `${hash("u_", c)} AS ${c}`;
    case "pseudo_recipient":
      // Holdouts list each system's own identifier: an e-mail address or a LINE user id.
      return `CASE WHEN channel = 'email' THEN ${hash("p_", `lower(trim(${c}))`)} ELSE ${hash("u_", c)} END AS ${c}`;
  }
}

/** The documented, tested layer the metrics are defined on. */
const MARTS = `
CREATE SCHEMA mart;

-- One row per order. Money in local currency and in EUR at the fixed rates of ref.fx.
CREATE VIEW mart.orders AS
SELECT o.id AS order_id,
       o.country_code AS market,
       o.currency,
       CAST(o.created_at_local AS DATE) AS order_date,
       o.created_at AS created_at_utc,
       o.customer_id,
       o.email AS person,
       o.total_price AS total_local,
       o.total_price / fx.per_eur AS total_eur,
       o.discount_code,
       o.financial_status,
       coalesce(nullif(regexp_extract(o.landing_site, 'utm_source=([^&]+)', 1), ''), '(none)') AS utm_source,
       nullif(regexp_extract(o.landing_site, 'utm_campaign=([^&]+)', 1), '') AS utm_campaign,
       TRY_CAST(nullif(regexp_extract(o.landing_site, 'utm_campaign=[a-z]+-([0-9]+)', 1), '') AS INTEGER) AS utm_campaign_id
FROM raw_shop.orders o JOIN ref.fx fx USING (currency);

-- One row per planned campaign, e-mail and LINE side by side.
-- opens counts every open the tool reports (Apple Mail Privacy Protection included);
-- opens_without_mpp only the opens a person really made, as far as the tool can tell. LINE has no MPP.
CREATE VIEW mart.campaigns AS
SELECT p.campaign_id, p.market, p.channel, p.theme, p.event_code, p.name,
       CAST(p.send_at_local AS DATE) AS send_date,
       p.send_at_utc,
       p.holdout_rate,
       coalesce(e.delivered, l.delivered) AS delivered,
       coalesce(e.unique_views, l.unique_impression) AS opens,
       coalesce(e.trackable_views, l.unique_impression) AS opens_without_mpp,
       coalesce(e.clickers, l.unique_click) AS clickers,
       e.unsubscriptions AS unsubscribes
FROM raw_crm.campaign_plan p
LEFT JOIN raw_email.campaigns e ON e.id = p.email_campaign_id
LEFT JOIN raw_line.message_insights l ON l.request_id = p.line_request_id;

-- One row per e-mail sent or deliberately held out: the base of every holdout comparison.
CREATE VIEW mart.email_sends AS
SELECT p.campaign_id, p.market, p.send_at_utc, e.email AS person, false AS holdout
FROM raw_crm.campaign_plan p
JOIN raw_email.events e ON e.campaign_id = p.email_campaign_id AND e.event = 'delivered'
UNION ALL
SELECT p.campaign_id, p.market, p.send_at_utc, h.recipient, true
FROM raw_crm.campaign_plan p JOIN raw_crm.holdouts h USING (campaign_id)
WHERE p.channel = 'email';
`;
