#!/usr/bin/env node
// madoguchi serve | check | sql | catalogue | eval

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromArgs, OPTIONS } from "./args.js";
import { createServer, catalogueMarkdown, VERSION } from "./server.js";
import { Warehouse } from "./warehouse.js";
import { lockdownChecks } from "./selfcheck.js";
import { runEvalCommand } from "./eval/command.js";

const USAGE = `madoguchi ${VERSION}: a read-only MCP server over Tsunagu, Koyomi and Kensa

  madoguchi serve  --config madoguchi.json     start the MCP server on stdio (for Claude Desktop, Claude Code, ...)
  madoguchi check  --config madoguchi.json     build the governed copy and prove every lock holds
  madoguchi sql    --config madoguchi.json "SELECT ..."   run one guarded query, as an agent would
  madoguchi catalogue                          print the metric catalogue
  madoguchi eval   --config madoguchi.json --runner oracle|openai|replay [...]   score an agent (see docs/EVAL.md)

Instead of --config: --tsunagu PATH [--koyomi PATH] [--kensa PATH] [--allow-host HOST]...
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "catalogue") {
    process.stdout.write(catalogueMarkdown());
    return 0;
  }
  if (command === "eval") return runEvalCommand(rest);

  const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  const cfg = configFromArgs(values);
  const t0 = Date.now();
  const wh = await Warehouse.open(cfg.tsunagu.database, cfg.limits);

  switch (command) {
    case "serve": {
      const server = await createServer(cfg, wh);
      const stop = async () => {
        await server.close();
        await wh.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.stdin.on("close", stop);
      await server.connect(new StdioServerTransport());
      process.stderr.write(`madoguchi ${VERSION} ready (${Date.now() - t0} ms)\n`);
      return -1; // keep running
    }
    case "check": {
      const results = await lockdownChecks(wh);
      let failed = 0;
      process.stdout.write(`Governed copy built in ${Date.now() - t0} ms: ${wh.tables.length} tables and views\n\n`);
      for (const r of results) {
        if (!r.ok) failed++;
        process.stdout.write(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}\n`);
      }
      process.stdout.write(`\n${results.length - failed}/${results.length} locks hold\n`);
      await wh.close();
      return failed ? 1 : 0;
    }
    case "sql": {
      const sql = positionals.join(" ");
      try {
        const r = await wh.select(sql);
        process.stdout.write(JSON.stringify(r, null, 1) + "\n");
        return 0;
      } catch (e) {
        process.stderr.write(`refused or failed: ${(e as Error).message}\n`);
        return 1;
      } finally {
        await wh.close();
      }
    }
    default:
      await wh.close();
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`madoguchi: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
