import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { CountingClient, modelAgent, oracleAgent } from "../src/eval/agent.js";
import { buildQuestions, type Question } from "../src/eval/questions.js";
import { finalAnswer, score } from "../src/eval/score.js";
import { DB, KOYOMI, connected } from "./helpers.js";

const q = (over: Partial<Question>): Question => ({
  id: "x", category: "kpi", question: "?", format: "number", expected: 1234.5, tolerance: 0.1, context: {}, ...over,
});

describe("scoring", () => {
  test("reads the line after ANSWER:", () => {
    assert.equal(finalAnswer("I looked at 2025-11.\nANSWER: 42"), "42");
    assert.equal(finalAnswer("42"), "42");
  });

  test("numbers with separators", () => {
    assert.ok(score(q({}), { id: "x", answer: "ANSWER: 1,234.5 EUR" }).correct);
    assert.ok(score(q({}), { id: "x", answer: "ANSWER: 1 234.5" }).correct);
    assert.ok(!score(q({}), { id: "x", answer: "ANSWER: 1,240" }).correct);
    assert.ok(!score(q({}), { id: "x", answer: "ANSWER: UNKNOWN" }).correct);
  });

  test("intervals must contain the truth and stay narrow", () => {
    const iq = q({ format: "interval", expected: 14, tolerance: 110 });
    assert.ok(score(iq, { id: "x", answer: "ANSWER: -23 to 132" }).correct);
    assert.ok(score(iq, { id: "x", answer: "ANSWER: -23-132" }).correct);
    assert.ok(!score(iq, { id: "x", answer: "ANSWER: 20 to 60" }).correct, "truth outside");
    assert.ok(!score(iq, { id: "x", answer: "ANSWER: -1000 to 1000" }).correct, "too wide");
  });

  test("abstentions, choices, dates, paths, leaks", () => {
    const u = q({ format: "unknown", expected: "UNKNOWN" });
    assert.ok(score(u, { id: "x", answer: "The data has no names. ANSWER: UNKNOWN" }).correct);
    const leak = score(u, { id: "x", answer: "it is a@example.com. ANSWER: UNKNOWN" });
    assert.ok(!leak.correct && leak.leaked_email);
    const ch = q({ format: "choice", choices: ["FR", "JP", "TW"], expected: "JP" });
    assert.ok(score(ch, { id: "x", answer: "ANSWER: jp" }).correct);
    assert.ok(!score(ch, { id: "x", answer: "ANSWER: FR" }).correct);
    assert.ok(score(q({ format: "date", expected: "2027-02-06" }), { id: "x", answer: "ANSWER: 2027-02-06 (Saturday)" }).correct);
    assert.ok(score(q({ format: "path", expected: "/ja/a.html" }), { id: "x", answer: "ANSWER: `/ja/a.html`." }).correct);
  });
});

describe("the oracle", () => {
  test("answers every question with the tools alone", async () => {
    const qs = await buildQuestions({ tsunagu: DB, koyomi: !!KOYOMI });
    assert.ok(qs.length >= (KOYOMI ? 24 : 19));
    const c = await connected();
    const oracle = oracleAgent(new CountingClient(c.client));
    const misses = [];
    for (const question of qs) {
      const s = score(question, await oracle.answer(question));
      if (!s.correct) misses.push(`${question.id}: ${s.parsed} vs ${s.expected}`);
    }
    await c.close();
    assert.deepEqual(misses, []);
  });
});

describe("a model behind an OpenAI-compatible API", () => {
  test("its tool calls go through MCP and its answer is scored", async () => {
    // A scripted model: first asks for a metric, then answers with what the tool returned.
    let turn = 0;
    const seen: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const msg = JSON.parse(body);
        seen.push(msg);
        const reply =
          turn++ === 0
            ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "query_metric", arguments: JSON.stringify({ metrics: ["orders"], markets: ["JP"] }) } }] }
            : { role: "assistant", content: `ANSWER: ${JSON.parse(msg.messages.at(-1).content).rows[0].orders}` };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: reply }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const c = await connected();
    const counting = new CountingClient(c.client);
    const agent = await modelAgent(counting, { baseUrl: `http://127.0.0.1:${port}/v1`, model: "scripted", maxSteps: 4, temperature: 0 });
    const qs = await buildQuestions({ tsunagu: DB, koyomi: false });
    const question = { ...qs.find((x) => x.id === "kpi-buyers-jp")!, id: "orders-jp", expected: 0 };
    const attempt = await agent.answer(question);
    assert.equal(attempt.tool_calls, 1);
    assert.match(attempt.answer, /^ANSWER: \d+$/);
    const first = seen[0] as { tools: { function: { name: string } }[]; messages: { role: string }[] };
    assert.ok(first.tools.some((t) => t.function.name === "campaign_lift"), "the MCP tools are offered to the model");
    assert.equal(first.messages[0]!.role, "system");
    await c.close();
    server.close();
  });
});
