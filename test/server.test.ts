import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildMetricQuery, MetricError } from "../src/metrics.js";
import { DB, KENSA, KOYOMI, connected, testConfig } from "./helpers.js";

type Conn = Awaited<ReturnType<typeof connected>>;

/** Independent numbers, straight from the source file. */
async function raw(sql: string) {
  const db = await DuckDBInstance.create(DB, { access_mode: "READ_ONLY" });
  const con = await db.connect();
  try {
    return (await con.runAndReadAll(sql)).getRowObjectsJson();
  } finally {
    con.closeSync();
    db.closeSync();
  }
}

describe("MCP tools", () => {
  let c: Conn;
  before(async () => {
    c = await connected();
  });
  after(async () => {
    await c.close();
  });

  test("the expected tools are listed, all marked read-only", async () => {
    const { tools } = await c.client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ["campaign_lift", "describe_data", "query_metric", "run_sql"];
    if (KOYOMI) expected.push("calendar_events", "lunar_date");
    if (KENSA) expected.push("seo_audit");
    assert.deepEqual(names, expected.sort());
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
  });

  test("describe_data hides the answer key and says what was removed", async () => {
    const r = await c.call("describe_data", { columns: true });
    assert.equal(r.isError, false);
    assert.doesNotMatch(r.text, /truth\./);
    assert.match(r.text, /pseudonyms/);
    assert.match(r.text, /mart\.orders/);
  });

  test("query_metric matches the raw tables", async () => {
    const [ref] = await raw("SELECT country_code AS m, count(*)::INTEGER AS n FROM raw_shop.orders GROUP BY 1 ORDER BY 1 LIMIT 1");
    const r = await c.call("query_metric", { metrics: ["orders"], by: ["market"] });
    const rows = JSON.parse(r.text).rows as { market: string; orders: number }[];
    assert.equal(rows.find((x) => x.market === ref!.m)?.orders, ref!.n);
  });

  test("query_metric explains its mistakes to the agent", async () => {
    let r = await c.call("query_metric", { metrics: ["orders", "click_rate"] });
    assert.ok(r.isError);
    assert.match(r.text, /two calls/);
    r = await c.call("query_metric", { metrics: ["revenue"] });
    assert.match(r.text, /unknown metric.*Known: orders/);
    r = await c.call("query_metric", { metrics: ["orders"], markets: ["FR') OR 1=1 --"] });
    assert.ok(r.isError, "an invalid market is refused by the schema");
  });

  test("filter values are bound, never pasted into SQL", () => {
    const { sql, values } = buildMetricQuery({ metrics: ["orders"], markets: ["FR' OR '1'='1"], date_from: "2025-01-01" });
    assert.doesNotMatch(sql, /OR '1'/);
    assert.deepEqual(values, ["FR' OR '1'='1", "2025-01-01"]);
    assert.throws(() => buildMetricQuery({ metrics: ["orders"], by: ["theme"] }), MetricError);
    assert.throws(() => buildMetricQuery({ metrics: ["orders"], channel: "line" }), MetricError);
  });

  test("run_sql answers a SELECT and refuses the rest", async () => {
    let r = await c.call("run_sql", { sql: "SELECT market, count(*) AS n FROM mart.campaigns GROUP BY 1 ORDER BY 1" });
    assert.equal(r.isError, false);
    assert.equal(JSON.parse(r.text).rows.length, 3);
    r = await c.call("run_sql", { sql: "DELETE FROM raw_shop.orders" });
    assert.ok(r.isError);
    assert.match(r.text, /only SELECT/);
    r = await c.call("run_sql", { sql: "SELECT * FROM truth.orders" });
    assert.ok(r.isError);
  });

  test("campaign_lift gives an interval and refuses LINE with the reason", async () => {
    const r = await c.call("campaign_lift", { market: "FR" });
    const lift = JSON.parse(r.text);
    assert.ok(lift.uplift_ci95_pts[0] <= lift.uplift_pts && lift.uplift_pts <= lift.uplift_ci95_pts[1]);
    assert.ok(lift.holdouts > 0 && lift.recipients > lift.holdouts);
    const line = await c.call("campaign_lift", { market: "JP", channel: "line" });
    assert.ok(line.isError);
    assert.match(line.text, /LINE Messaging API/);
  });

  test("the weekly brief prompt names the tools to use", async () => {
    const p = await c.client.getPrompt({ name: "weekly_brief", arguments: { market: "JP", week_start: "2025-11-03" } });
    const t = (p.messages[0]!.content as { text: string }).text;
    assert.match(t, /campaign_lift/);
  });

  test("the metric catalogue is a resource", async () => {
    const r = await c.client.readResource({ uri: "madoguchi://catalogue" });
    assert.match((r.contents[0] as { text: string }).text, /open_rate_without_mpp/);
  });
});

describe("audit log", () => {
  test("every call is logged, without its results", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "madoguchi-audit-"));
    const log = path.join(dir, "audit.jsonl");
    const c = await connected(testConfig({ auditLog: log }));
    await c.call("query_metric", { metrics: ["buyers"], by: ["market"] });
    await c.call("run_sql", { sql: "DROP TABLE x" });
    await c.close();
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].tool, "query_metric");
    assert.equal(lines[0].ok, true);
    assert.equal(lines[0].rows, 3);
    assert.equal(lines[0].result, undefined);
    assert.equal(lines[1].ok, false);
    assert.match(lines[1].error, /only SELECT/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Koyomi", { skip: !KOYOMI && "MADOGUCHI_TEST_KOYOMI not set" }, () => {
  test("calendar_events returns Seollal 2027 for Korea", async () => {
    const c = await connected();
    const r = await c.call("calendar_events", { markets: ["kr"], date_from: "2027-02-01", date_to: "2027-02-28" });
    const seollal = JSON.parse(r.text).events.find((e: { id: string }) => e.id === "kr-seollal");
    assert.equal(seollal.start, "2027-02-06");
    const lunar = await c.call("lunar_date", { date: "2027-02-07", calendar: "korean" });
    assert.match(lunar.text, /2027-01-01/);
    const bad = await c.call("calendar_events", { markets: ["kr"], date_from: "2020-01-01", date_to: "2030-01-01" });
    assert.ok(bad.isError);
    await c.close();
  });
});

describe("Kensa", { skip: !KENSA && "MADOGUCHI_TEST_KENSA not set" }, () => {
  test("seo_audit refuses hosts that are not allowed, credentials and other schemes", async () => {
    const c = await connected();
    for (const url of ["https://www.example.com/", "http://user:pw@127.0.0.1/", "file:///etc/hosts", "http://127.0.0.1.example.com/"]) {
      const r = await c.call("seo_audit", { url });
      assert.ok(r.isError, url);
    }
    await c.close();
  });
});
