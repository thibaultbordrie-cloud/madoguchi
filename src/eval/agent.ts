// The agents that can be scored, all talking to Madoguchi over MCP.
//
// - oracle: a deterministic script that answers with the tools only. CI runs it: 100 % proves the tools
//   agree with the independent answer key and that every question can be answered with them.
// - openai: any model behind an OpenAI-compatible chat API with tool calling (Ollama, LM Studio,
//   llama.cpp server... on this computer). Madoguchi never calls a model by itself.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Question } from "./questions.js";
import type { Attempt } from "./score.js";

export interface Agent {
  name: string;
  answer(q: Question): Promise<Attempt>;
}

/** An MCP client that counts tool calls and errors for the current question. */
export class CountingClient {
  calls = 0;
  errors = 0;
  constructor(readonly client: Client) {}

  reset() {
    this.calls = 0;
    this.errors = 0;
  }

  async raw(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.calls++;
    const r = (await this.client.callTool({ name, arguments: args })) as CallToolResult;
    if (r.isError) this.errors++;
    return r;
  }

  async json<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.raw(name, args);
    const t = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (r.isError) throw new Error(t);
    try {
      return JSON.parse(t) as T;
    } catch {
      return t as T;
    }
  }
}

export const SYSTEM_PROMPT = `You are a careful CRM analyst. Answer with the tools of the Madoguchi server; call describe_data first if you need to know what exists.
Never guess a number. If the data cannot answer the question (it is not there, it is personal data, or it cannot be measured), reply UNKNOWN.
End your reply with one line: ANSWER: <your answer>`;

// ---------- oracle ----------

export function oracleAgent(c: CountingClient): Agent {
  const metric = async (metrics: string[], extra: Record<string, unknown>) =>
    (await c.json<{ rows: Record<string, number | string>[] }>("query_metric", { metrics, ...extra })).rows;

  const solve = async (q: Question): Promise<string> => {
    const x = q.context;
    const markets = x.market ? [String(x.market)] : undefined;
    const period = x.from ? { date_from: x.from, date_to: x.to } : {};
    switch (q.id) {
      case "kpi-orders-jp":
        return String((await metric(["orders"], { markets, ...period }))[0]!.orders);
      case "kpi-revenue-tw":
        return String((await metric(["gross_revenue_eur"], { markets, ...period }))[0]!.gross_revenue_eur);
      case "kpi-basket-fr":
        return String((await metric(["avg_basket_eur"], { markets }))[0]!.avg_basket_eur);
      case "kpi-buyers-jp":
        return String((await metric(["buyers"], { markets }))[0]!.buyers);
      case "kpi-open-fr":
        return String((await metric(["open_rate_without_mpp"], { markets, channel: "email" }))[0]!.open_rate_without_mpp);
      case "kpi-lineclick-tw":
        return String((await metric(["click_rate"], { markets, channel: "line" }))[0]!.click_rate);
      case "kpi-utm-jp":
        return String((await metric(["utm_order_share"], { markets }))[0]!.utm_order_share);
      case "kpi-campaigns-fr":
        return String((await metric(["campaigns"], { markets, channel: "email", ...period }))[0]!.campaigns);
      case "cmp-revenue": {
        const rows = await metric(["gross_revenue_eur"], { by: ["market"], ...period });
        return String(rows.sort((a, b) => Number(b.gross_revenue_eur) - Number(a.gross_revenue_eur))[0]!.market);
      }
      case "cmp-emailclick": {
        const rows = await metric(["click_rate"], { by: ["market"], channel: "email" });
        return String(rows.sort((a, b) => Number(b.click_rate) - Number(a.click_rate))[0]!.market);
      }
      case "cmp-bestmonth-fr": {
        const rows = await metric(["orders"], { by: ["month"], markets });
        return String(rows.sort((a, b) => Number(b.orders) - Number(a.orders) || String(a.month).localeCompare(String(b.month)))[0]!.month);
      }
      case "cmp-channel-jp": {
        const rows = await metric(["click_rate"], { by: ["channel"], markets });
        return String(rows.sort((a, b) => Number(b.click_rate) - Number(a.click_rate))[0]!.channel);
      }
      case "privacy-email":
      case "privacy-name":
      case "causal-line-jp":
        // The oracle checks the tools refuse or lack the data, then abstains.
        await c.raw("describe_data", {});
        return "UNKNOWN";
    }
    if (q.id.startsWith("causal-")) {
      const lift = await c.json<{ incremental_orders_ci95: [number, number]; significant: boolean; uplift_ci95_pts: [number, number] }>(
        "campaign_lift",
        { market: x.market, window_days: 3 },
      );
      if (q.format === "interval") return `${lift.incremental_orders_ci95[0]} to ${lift.incremental_orders_ci95[1]}`;
      return lift.uplift_ci95_pts[0] > 0 ? "yes" : "no";
    }
    if (q.category === "calendar") {
      const y = Number(x.year);
      const r = await c.json<{ events: { id: string; start: string }[] }>("calendar_events", {
        markets: [x.market],
        date_from: `${y}-01-01`,
        date_to: `${y}-12-31`,
      });
      return r.events.find((e) => e.id === x.event && e.start.startsWith(String(y)))?.start ?? "UNKNOWN";
    }
    if (q.category === "seo") {
      const r = await c.json<{ findings: { rule: string; url: string }[] }>("seo_audit", { url: x.url, max_pages: 200 });
      return r.findings.find((f) => f.rule === x.rule)?.url ?? "UNKNOWN";
    }
    throw new Error(`the oracle does not know question ${q.id}`);
  };

  return {
    name: "oracle",
    async answer(q) {
      c.reset();
      const t0 = Date.now();
      const answer = `ANSWER: ${await solve(q)}`;
      return { id: q.id, answer, tool_calls: c.calls, tool_errors: c.errors, seconds: (Date.now() - t0) / 1000 };
    },
  };
}

// ---------- OpenAI-compatible model ----------

export interface ModelOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps: number;
  temperature: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function modelAgent(c: CountingClient, opts: ModelOptions, transcript?: (line: unknown) => void): Promise<Agent> {
  const { tools } = await c.client.listTools();
  const fnTools = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
  }));
  const chat = async (messages: ChatMessage[]) => {
    const res = await fetch(new URL("chat/completions", opts.baseUrl.endsWith("/") ? opts.baseUrl : opts.baseUrl + "/"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: opts.model, messages, tools: fnTools, temperature: opts.temperature }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`model endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices: { message: ChatMessage }[] };
    return body.choices[0]!.message;
  };

  return {
    name: `${opts.model}`,
    async answer(q) {
      c.reset();
      const t0 = Date.now();
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: q.question },
      ];
      let final = "";
      for (let step = 0; step < opts.maxSteps; step++) {
        const msg = await chat(messages);
        messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (!msg.tool_calls?.length) {
          final = msg.content ?? "";
          break;
        }
        for (const call of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            /* the server will report the missing arguments */
          }
          const r = await c.raw(call.function.name, args);
          const out = r.content.map((x) => (x.type === "text" ? x.text : "")).join("").slice(0, 20_000);
          messages.push({ role: "tool", tool_call_id: call.id, content: out });
        }
      }
      transcript?.({ id: q.id, model: opts.model, messages });
      return { id: q.id, answer: final || "(no final answer within the step limit)", tool_calls: c.calls, tool_errors: c.errors, seconds: (Date.now() - t0) / 1000 };
    },
  };
}
