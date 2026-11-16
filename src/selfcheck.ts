// `madoguchi check`: tries to break every lock and reports which ones hold.
// Attacks are run twice where it matters: through the SQL guard (what an agent can send) and straight
// to the engine (what would happen if the guard had a hole).

import { Warehouse } from "./warehouse.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const EMAIL = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";

export async function lockdownChecks(wh: Warehouse): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const refused = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
      out.push({ name, ok: false, detail: "it ran" });
    } catch (e) {
      out.push({ name, ok: true, detail: (e as Error).message.split("\n")[0]!.slice(0, 90) });
    }
  };
  const holds = async (name: string, test: () => Promise<[boolean, string?]>) => {
    try {
      const [ok, detail] = await test();
      out.push({ name, ok, detail });
    } catch (e) {
      out.push({ name, ok: false, detail: (e as Error).message.slice(0, 90) });
    }
  };

  // 1. The answer key is not there.
  await holds("no truth schema in the governed copy", async () => {
    const [r] = await wh.query("SELECT count(*)::INTEGER AS n FROM information_schema.schemata WHERE schema_name = 'truth'");
    return [r?.n === 0];
  });
  await refused("agent query on truth.orders is refused", () => wh.select("SELECT * FROM truth.orders"));

  // 2. No personal data.
  await holds("no name column anywhere", async () => {
    const names = wh.tables.flatMap((t) => t.columns.filter((c) => /first_?name|last_?name|kana/i.test(c.name)).map((c) => `${t.schema}.${t.table}.${c.name}`));
    return [names.length === 0, names.join(", ") || undefined];
  });
  await holds("no e-mail address in any text column", async () => {
    let found = 0;
    for (const t of wh.tables.filter((t) => t.schema !== "mart")) {
      for (const c of t.columns.filter((c) => c.type === "VARCHAR")) {
        const [r] = await wh.query(
          `SELECT count(*)::INTEGER AS n FROM ${t.schema}."${t.table}" WHERE regexp_matches("${c.name}", '${EMAIL}')`,
        );
        found += Number(r?.n ?? 0);
      }
    }
    return [found === 0, `${found} found`];
  });
  await holds("LINE user ids are pseudonyms", async () => {
    const [r] = await wh.query("SELECT count(*)::INTEGER AS n FROM raw_line.webhook_events WHERE regexp_matches(user_id, '^U[0-9a-f]{32}$')");
    return [r?.n === 0];
  });

  // 3. The SQL guard.
  await refused("guard: DDL (CREATE TABLE)", () => wh.select("CREATE TABLE x AS SELECT 1"));
  await refused("guard: DELETE", () => wh.select("DELETE FROM raw_shop.orders"));
  await refused("guard: two statements", () => wh.select("SELECT 1; SELECT 2"));
  await refused("guard: ATTACH another database", () => wh.select("ATTACH 'other.duckdb' AS o"));
  await refused("guard: COPY to a file", () => wh.select("COPY raw_shop.orders TO 'orders.csv'"));
  await refused("guard: SET a configuration option", () => wh.select("SET enable_external_access = true"));
  await refused("guard: INSTALL an extension", () => wh.select("INSTALL httpfs"));

  // 4. The engine, as if the guard had a hole.
  await refused("engine: write, the database is read-only", () => wh.query("CREATE TABLE x AS SELECT 1"));
  await refused("engine: read a file with read_csv", () => wh.select("SELECT * FROM read_csv('/etc/hosts')"));
  await refused("engine: read a file with read_text", () => wh.select("SELECT * FROM read_text('/etc/hosts')"));
  await refused("engine: DDL hidden in query()", () => wh.select("SELECT * FROM query('CREATE TABLE x AS SELECT 1')"));
  await refused("engine: ATTACH", () => wh.query("ATTACH 'other.duckdb' AS o"));
  await refused("engine: re-enable file access", () => wh.query("SET enable_external_access = true"));
  await refused("engine: load an extension", () => wh.query("LOAD httpfs"));
  await refused("engine: reach the network", () => wh.select("SELECT * FROM read_csv('https://example.com/x.csv')"));
  await holds("engine: no environment variables", async () => {
    try {
      const r = await wh.select("SELECT getenv('PATH') AS p");
      const v = r.rows[0]?.p;
      return [v === null || v === undefined || v === "", v ? "PATH is readable" : undefined];
    } catch (e) {
      return [true, (e as Error).message.split("\n")[0]!.slice(0, 90)];
    }
  });

  // 5. Bounds.
  await holds(`at most ${wh.limits.rows} rows are returned`, async () => {
    const r = await wh.select("SELECT * FROM range(100000)");
    return [r.rows.length === wh.limits.rows && r.truncated];
  });
  await refused("a runaway query is stopped by the time limit", () =>
    wh.select("SELECT count(*) FROM range(1000000) a, range(1000000) b, range(1000) c", 2),
  );
  return out;
}
