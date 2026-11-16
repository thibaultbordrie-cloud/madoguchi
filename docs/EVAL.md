# The benchmark

Most agent demos show one good answer. This one counts how many answers are right, on questions whose answer is known for sure.

## Where the answers come from

The answer key is built separately from the server, so the server cannot grade itself:

| Category | Questions | Answer key |
|---|---|---|
| `kpi` | orders, revenue, average basket, buyers, open rate without Apple MPP, LINE click rate, last-click share, campaigns sent | plain SQL on the raw tables of the source file, not on Madoguchi's marts |
| `comparison` | best market, best month, best channel | same |
| `causal` | how many orders e-mail really caused (95% interval), whether the holdout proves an effect, what LINE caused | the simulation's hidden `truth` schema, and the holdout comparison computed from the raw tables |
| `privacy` | an e-mail address, a family name | the right answer is `UNKNOWN` |
| `calendar` | equinox days, Seollal, Chuseok, Tomb-Sweeping Day in 2027 to 2031 | the Python package `holidays`, not Koyomi |
| `seo` | which page of Kensa's trap site has a given defect | Kensa's answer key of planted defects |

Questions follow the data: periods are taken from the generated world, so the set works on any Tsunagu scenario.

## Scoring

The agent ends its reply with `ANSWER: …`.

- **Numbers** must be within a stated tolerance (exact for counts, 0.05 points for rates, 0.5 % for revenue).
- **Intervals** must contain the true value **and** be no wider than 1.5 times the holdout's own 95% interval, so "between -1,000,000 and 1,000,000" is wrong.
- **Choices, months, dates, paths** must match exactly.
- **`UNKNOWN`** is right only when the data cannot answer. Saying it to an answerable question counts as a miss, and so does answering an unanswerable one.

The report also counts tool calls, tool errors, wrong abstentions, missed abstentions and replies that contain an e-mail address.

## The oracle

`--runner oracle` is a script that answers every question with the MCP tools only. It is not smart: it calls the right tool with the right filters. CI runs it on the two-year world with `--min-accuracy 100`, which proves two things on every push:

1. every question can be answered with the tools;
2. the tools agree with the independent answer key (the metric layer, the holdout maths, the calendar, the audit).

Result on the standard world: **27/27**, one tool call per question.

## Scoring a real model

Madoguchi never calls a model by itself. To score one, run it behind an OpenAI-compatible API on your computer, for example with [Ollama](https://ollama.com):

```bash
ollama pull qwen3:8b
madoguchi eval --config madoguchi.json --runner openai --model qwen3:8b
# report: eval-results/report.md, every conversation: eval-results/transcripts.jsonl
```

The endpoint must be on this computer unless you add `--allow-remote-model`: questions and tool results would otherwise leave it. If the endpoint needs a key, it is read from `MADOGUCHI_MODEL_API_KEY` and never written anywhere.

Any other agent (Claude Desktop, Claude Code…) can be scored by hand:

```bash
madoguchi eval --config madoguchi.json --list > questions.jsonl     # questions only, no answers
# ask each question to the agent connected to Madoguchi, write {"id": "...", "answer": "..."} per line
madoguchi eval --config madoguchi.json --runner replay --answers answers.jsonl
```

No model results are published here yet: they depend on the model, its size and the machine, and the point of the tool is that you measure your own.

## Limits

- 27 questions is enough to catch a broken tool or a careless agent, not to rank close models. Each category is small on purpose: the questions are meant to be read.
- The holdout groups of Tsunagu hold 5 % of each audience, so the honest answer to "did e-mail work?" is often "we cannot tell". That is a feature: an agent that reports last-click as an effect fails the causal questions.
- The answer key for causal questions comes from the simulation, which knows why every order happened. Real data never does; that is why this benchmark uses a fictional world.
