// madoguchi eval: build the questions and their key, run an agent against the server, write a report.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configFromArgs, OPTIONS } from "../args.js";
import type { Config } from "../config.js";
import { createServer, VERSION } from "../server.js";
import { run } from "../tools-external.js";
import { Warehouse } from "../warehouse.js";
import { CountingClient, modelAgent, oracleAgent, type Agent } from "./agent.js";
import { buildQuestions, type Question } from "./questions.js";
import { score, summarise, type Attempt, type Scored, type Summary } from "./score.js";

const EVAL_OPTIONS = {
  ...OPTIONS,
  runner: { type: "string", default: "oracle" },
  model: { type: "string" },
  "base-url": { type: "string", default: "http://127.0.0.1:11434/v1" },
  "allow-remote-model": { type: "boolean", default: false },
  "max-steps": { type: "string", default: "10" },
  temperature: { type: "string", default: "0" },
  answers: { type: "string" },
  list: { type: "boolean", default: false },
  only: { type: "string" },
  out: { type: "string", default: "eval-results" },
  "seo-seed": { type: "string", default: "3" },
  "min-accuracy": { type: "string", default: "0" },
} as const;

export async function runEvalCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: EVAL_OPTIONS, allowPositionals: false });
  const cfg = configFromArgs({ ...values, "no-audit-log": true });
  cfg.auditLog = null;
  const seo = cfg.kensa ? await startTrapSite(cfg, Number(values["seo-seed"])) : undefined;
  try {
    let questions = await buildQuestions({ tsunagu: cfg.tsunagu.database, koyomi: !!cfg.koyomi, seo: seo?.info });
    if (values.only) {
      const re = new RegExp(values.only);
      questions = questions.filter((q) => re.test(q.id) || re.test(q.category));
    }
    if (values.list) {
      for (const q of questions) process.stdout.write(JSON.stringify({ id: q.id, category: q.category, question: q.question }) + "\n");
      return 0;
    }

    const wh = await Warehouse.open(cfg.tsunagu.database, cfg.limits);
    const server = await createServer(cfg, wh);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "madoguchi-eval", version: VERSION });
    await Promise.all([server.connect(a), client.connect(b)]);
    const counting = new CountingClient(client);
    fs.mkdirSync(values.out!, { recursive: true });

    try {
      let agent: Agent;
      let attempts: Attempt[] | undefined;
      switch (values.runner) {
        case "oracle":
          agent = oracleAgent(counting);
          break;
        case "openai": {
          if (!values.model) throw new Error("--runner openai needs --model (for example qwen3:8b with Ollama)");
          const base = new URL(values["base-url"]!);
          if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !values["allow-remote-model"]) {
            throw new Error(`${base.hostname} is not this computer. Questions and tool results would leave it: add --allow-remote-model if that is what you want.`);
          }
          const transcripts = fs.createWriteStream(path.join(values.out!, "transcripts.jsonl"));
          agent = await modelAgent(
            counting,
            {
              baseUrl: base.href,
              model: values.model,
              apiKey: process.env.MADOGUCHI_MODEL_API_KEY,
              maxSteps: Number(values["max-steps"]),
              temperature: Number(values.temperature),
            },
            (line) => transcripts.write(JSON.stringify(line) + "\n"),
          );
          break;
        }
        case "replay": {
          if (!values.answers) throw new Error("--runner replay needs --answers FILE (JSON lines: {\"id\": ..., \"answer\": ...})");
          attempts = fs.readFileSync(values.answers, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Attempt);
          agent = { name: `replay of ${path.basename(values.answers)}`, answer: async () => ({ id: "", answer: "" }) };
          break;
        }
        default:
          throw new Error(`unknown runner ${values.runner} (oracle, openai or replay)`);
      }

      const results: Scored[] = [];
      for (const q of questions) {
        let attempt: Attempt;
        if (attempts) {
          attempt = attempts.find((x) => x.id === q.id) ?? { id: q.id, answer: "" };
        } else {
          try {
            attempt = await agent.answer(q);
          } catch (e) {
            attempt = { id: q.id, answer: `(agent failed: ${(e as Error).message})`, tool_calls: counting.calls, tool_errors: counting.errors };
          }
        }
        const s = score(q, attempt);
        results.push(s);
        process.stderr.write(`${s.correct ? "ok  " : "MISS"} ${q.id.padEnd(28)} ${s.parsed || "(nothing)"}${s.correct ? "" : `   expected ${s.expected}`}\n`);
      }
      const summary = summarise(questions, results);
      const report = { madoguchi: VERSION, agent: agent.name, dataset: path.basename(cfg.tsunagu.database), at: new Date().toISOString(), summary, results };
      fs.writeFileSync(path.join(values.out!, "report.json"), JSON.stringify(report, null, 1) + "\n");
      fs.writeFileSync(path.join(values.out!, "report.md"), markdown(agent.name, questions, summary, results));
      process.stdout.write(`\n${agent.name}: ${summary.correct}/${summary.questions} correct (${summary.accuracy} %), report in ${values.out}/report.md\n`);
      return summary.accuracy >= Number(values["min-accuracy"]) ? 0 : 1;
    } finally {
      await client.close();
      await server.close();
      await wh.close();
    }
  } finally {
    seo?.stop();
  }
}

function markdown(agent: string, qs: Question[], s: Summary, rs: Scored[]): string {
  const byId = new Map(qs.map((q) => [q.id, q]));
  const lines = [
    `# Madoguchi eval: ${agent}`,
    "",
    `**${s.correct}/${s.questions} correct (${s.accuracy} %)** · average ${s.avg_tool_calls} tool calls per question · ${s.tool_errors} tool errors`,
    "",
    "| Category | Correct |",
    "|---|---|",
    ...Object.entries(s.by_category).map(([k, v]) => `| ${k} | ${v.correct}/${v.questions} |`),
    "",
    `- Answered UNKNOWN when the data could answer: ${s.wrong_abstentions}`,
    `- Gave an answer when the data could not answer: ${s.missed_abstentions}`,
    `- Replies containing an e-mail address: ${s.email_leaks}`,
    "",
    "| Question | Result | Answer | Expected |",
    "|---|---|---|---|",
    ...rs.map((r) => `| \`${r.id}\` ${byId.get(r.id)?.question.replace(/\|/g, "/").slice(0, 90)}… | ${r.correct ? "ok" : "**miss**"} | ${r.parsed || "-"} | ${r.expected} |`),
  ];
  return lines.join("\n") + "\n";
}

// ---------- Kensa's trap site, served on this computer for the SEO questions ----------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startTrapSite(cfg: Config, seed: number) {
  const bin = cfg.kensa!.binary;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "madoguchi-trap-"));
  await run(bin, ["fixture", "--out", dir, "--seed", String(seed)], { timeoutSeconds: 60 });
  const key = JSON.parse(fs.readFileSync(path.join(dir, "answer-key.json"), "utf8")) as { expected: { rule: string; url: string }[] };
  const port = await freePort();
  const child: ChildProcess = spawn(bin, ["serve", path.join(dir, "site"), "--port", String(port)], { stdio: "ignore", windowsHide: true });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    info: { origin, key: key.expected },
    stop: () => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
