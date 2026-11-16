// The real thing: `madoguchi serve` started as a separate process, spoken to over stdio,
// the way Claude Desktop or Claude Code start it.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DB } from "./helpers.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

test("madoguchi serve speaks MCP on stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "serve", "--tsunagu", DB, "--no-audit-log"],
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);
  const info = client.getServerVersion();
  assert.equal(info?.name, "madoguchi");
  assert.match(client.getInstructions() ?? "", /describe_data first/);
  const r = (await client.callTool({ name: "query_metric", arguments: { metrics: ["campaigns"], by: ["channel"] } })) as {
    content: { text: string }[];
  };
  const rows = JSON.parse(r.content[0]!.text).rows as { channel: string }[];
  assert.deepEqual(rows.map((x) => x.channel), ["email", "line"]);
  await client.close();
});
