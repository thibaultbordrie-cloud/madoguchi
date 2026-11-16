# Security model

Madoguchi lets an AI agent query CRM data. The agent is treated as an untrusted user: it may be wrong, it may be manipulated by text it reads (prompt injection), or it may simply try things. The question is not whether the agent behaves, but what the worst thing it could do is.

The answer should be: read a pseudonymised copy of the data, within limits, and leave a trace.

## Threats and locks

| Threat | Lock | Tested by |
|---|---|---|
| The agent reads the answer key and "solves" the benchmark | The `truth` schema is never copied into the governed copy | `check`: no truth schema; `truth.orders` refused |
| The agent reads or repeats personal data | Names are dropped; e-mail addresses (after `lower(trim())`) and LINE user ids become salted SHA-256 pseudonyms. The salt is new at every start, so pseudonyms cannot be linked across sessions | `check`: no name column, no e-mail address in any text column, no raw LINE id; benchmark questions `privacy-*` |
| A new personal column appears upstream and leaks | Every column that looks personal (`email`, `name`, `phone`, `address`, `user_id`, `recipient`…) needs an explicit rule, or the build stops | `warehouse.test.ts`: a `phone` column stops the build |
| The agent changes or deletes data | The agent's SQL must parse as exactly one SELECT (`json_serialize_sql`). Behind that, the copy is opened read-only | `check` and `warehouse.test.ts`: 19 kinds of statement refused by the guard; writes refused by the engine |
| The agent reads files, other databases or the network | DuckDB starts with `enable_external_access = false`, extensions off, configuration locked. `read_csv`, `read_text`, `ATTACH`, `COPY`, `INSTALL`, `LOAD`, URLs: all refused, even inside a SELECT | `check`: each one tried straight on the engine, as if the guard had a hole |
| The agent turns the protection off | `lock_configuration = true`: no `SET` works after start | `check`: `SET enable_external_access = true` refused |
| The agent exhausts the machine | A time limit per query (interrupts DuckDB), a row limit per result (rows are streamed, never all loaded), 2 threads | `check`: a cross join is stopped; `range(100000)` returns 200 rows |
| The agent injects SQL through a tool argument | Metric names, dimensions and markets are checked against fixed lists; values are bound as parameters, never pasted into SQL | `server.test.ts` |
| The agent makes Kensa crawl anything | `seo_audit` only accepts http(s) URLs on `kensa.allowedHosts` (default: this computer), without credentials | `server.test.ts`: other hosts, `user:pw@`, `file://`, look-alike hosts refused |
| A child program inherits secrets | Koyomi and Kensa run without a shell, with fixed arguments, a time limit, an output cap, and an environment reduced to `PATH`, `HOME` and temp folders | code review: `tools-external.ts` |
| Error messages reveal the machine | Local paths are replaced by `<tmp>`, `<cwd>`, `~` before an error reaches the agent | code review: `server.ts` |
| Nobody knows what the agent did | Every call is logged (time, tool, arguments, duration, row count, error) in a JSON-lines file with owner-only permissions. Results are never logged, so the log is not a copy of the data | `server.test.ts`: the log has no result |

## What it does not protect against

- **A wrong answer.** The locks stop an agent from doing damage; they do not make it right. That is what the [benchmark](EVAL.md) measures.
- **Re-identification inside a session.** A pseudonym is stable for a session, so an agent can follow one customer's orders. That is needed for analysis (repeat purchase, holdout comparison) and acceptable on fictional data; on real data, aggregate-only tools would be the next step.
- **The person running Madoguchi.** They can read the source database directly; Madoguchi governs the agent, not its operator.
- **A model provider.** With `madoguchi eval --runner openai`, questions and tool results go to the model endpoint. The default accepts only an endpoint on this computer; `--allow-remote-model` is required to send them elsewhere.
