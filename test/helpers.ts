// Shared test setup. The tests need a Tsunagu world: `tsunagu generate --scenario tiny --out PATH`,
// then MADOGUCHI_TEST_DB=PATH. Koyomi and Kensa binaries are optional (MADOGUCHI_TEST_KOYOMI,
// MADOGUCHI_TEST_KENSA): the tests that need them are skipped without them.

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { Warehouse } from "../src/warehouse.js";

export const DB = process.env.MADOGUCHI_TEST_DB ?? "";
export const KOYOMI = process.env.MADOGUCHI_TEST_KOYOMI || undefined;
export const KENSA = process.env.MADOGUCHI_TEST_KENSA || undefined;

if (!DB || !fs.existsSync(DB)) {
  throw new Error("set MADOGUCHI_TEST_DB to a Tsunagu database (tsunagu generate --scenario tiny --out data/tiny.duckdb)");
}

export function testConfig(extra: Record<string, unknown> = {}): Config {
  return parseConfig(
    {
      tsunagu: { database: DB },
      ...(KOYOMI ? { koyomi: { binary: KOYOMI } } : {}),
      ...(KENSA ? { kensa: { binary: KENSA } } : {}),
      auditLog: null,
      ...extra,
    },
    process.cwd(),
  );
}

export async function connected(cfg = testConfig()) {
  const wh = await Warehouse.open(cfg.tsunagu.database, cfg.limits);
  const server = await createServer(cfg, wh);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    wh,
    client,
    async call(name: string, args: Record<string, unknown>) {
      const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      return { isError: !!r.isError, text: r.content.map((c) => c.text).join("") };
    },
    async close() {
      await client.close();
      await server.close();
      await wh.close();
    },
  };
}
