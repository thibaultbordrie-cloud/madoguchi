import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { lockdownChecks } from "../src/selfcheck.js";
import { GuardError, Warehouse } from "../src/warehouse.js";
import { DB } from "./helpers.js";

describe("governed copy", () => {
  let wh: Warehouse;
  before(async () => {
    wh = await Warehouse.open(DB, { rows: 50, timeoutSeconds: 10 });
  });
  after(async () => {
    await wh.close();
  });

  test("every lock of `madoguchi check` holds", async () => {
    const failed = (await lockdownChecks(wh)).filter((r) => !r.ok);
    assert.deepEqual(failed, []);
  });

  test("the guard refuses everything that is not one SELECT", async () => {
    const attacks = [
      "DROP TABLE raw_shop.orders",
      "UPDATE raw_shop.orders SET total_price = 0",
      "INSERT INTO ref.fx VALUES ('USD', 1)",
      "SELECT 1; DROP TABLE raw_shop.orders",
      "SELECT 1 /* */ ; DELETE FROM ref.fx",
      "EXPORT DATABASE 'out'",
      "IMPORT DATABASE 'in'",
      "CALL pragma_version()",
      "PRAGMA enable_profiling",
      "VACUUM",
      "CHECKPOINT",
      "DETACH madoguchi",
      "USE memory",
      "PREPARE p AS SELECT 1",
      "EXECUTE p",
      "CREATE MACRO m() AS 1",
      "CREATE SECRET s (TYPE http)",
      "LOAD 'x.duckdb_extension'",
      "",
    ];
    for (const sql of attacks) {
      await assert.rejects(wh.select(sql), GuardError, `not refused: ${sql}`);
    }
  });

  test("a SELECT with a CTE, a window and a comment is accepted", async () => {
    const r = await wh.select(`-- orders per market
      WITH o AS (SELECT market, total_eur FROM mart.orders)
      SELECT market, count(*) AS n, rank() OVER (ORDER BY count(*) DESC) AS r FROM o GROUP BY market ORDER BY market`);
    assert.deepEqual(r.columns, ["market", "n", "r"]);
    assert.equal(r.rows.length, 3);
  });

  test("the marts agree with the raw tables", async () => {
    const [a] = await wh.query("SELECT count(*)::INTEGER AS n, round(sum(total_eur), 2) AS eur FROM mart.orders");
    const [b] = await wh.query(
      "SELECT count(*)::INTEGER AS n, round(sum(total_price / per_eur), 2) AS eur FROM raw_shop.orders JOIN ref.fx USING (currency)",
    );
    assert.deepEqual(a, b);
    const [c] = await wh.query("SELECT count(*)::INTEGER AS n FROM mart.campaigns WHERE delivered IS NULL");
    assert.equal(c?.n, 0, "every planned campaign has its statistics");
  });

  test("pseudonyms still join: e-mail sends find their buyers", async () => {
    const [r] = await wh.query(
      "SELECT count(*)::INTEGER AS n FROM mart.email_sends s JOIN mart.orders o ON o.person = s.person",
    );
    assert.ok(Number(r?.n) > 0);
  });
});

test("a column that looks personal and has no rule stops the build", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "madoguchi-test-"));
  const file = path.join(dir, "new-column.duckdb");
  const db = await DuckDBInstance.create(file);
  const con = await db.connect();
  await con.run("CREATE SCHEMA raw_shop; CREATE TABLE raw_shop.customers (id INTEGER, phone VARCHAR)");
  con.closeSync();
  db.closeSync();
  await assert.rejects(Warehouse.open(file, { rows: 10, timeoutSeconds: 5 }), /raw_shop\.customers\.phone looks personal/);
  fs.rmSync(dir, { recursive: true, force: true });
});
