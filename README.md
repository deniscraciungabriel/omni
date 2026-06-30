# omni

> A durable, observable, self-improving agentic operating system you talk to — with **zero dependencies**.

[![ci](https://github.com/deniscraciungabriel/omni/actions/workflows/ci.yml/badge.svg)](https://github.com/deniscraciungabriel/omni/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)
![dependencies](https://img.shields.io/badge/dependencies-0-blue)
![license](https://img.shields.io/badge/license-MIT-green)

**omni** turns natural-language requests into **verified** work. You converse with an entity
("Omni") that decomposes goals into tasks, runs specialized workflows, keeps durable memory,
governs risky actions, and improves itself behind an evaluation suite — built entirely on the Node
standard library. Connect any OpenAI-compatible model to add free-form understanding; that step is
**optional and last**. Everything else works on a deterministic brain with no setup.

```text
   ____  __  __ _   _ ___        you › review this contract evals/fixtures/sample-msa.txt
  / __ \|  \/  | \ | |_ _|       Omni › Done — ran the contract harness (5 phases).
 | |  | | |\/| |  \| || |               Risk score: 4 (MEDIUM); flagged uncapped liability.
 | |__| | |  | | |\  || |        you › remember my deploy window is Tuesday mornings
  \____/|_|  |_|_| \_|___|       Omni › Noted and remembered. I'll recall it later.
```

## Why omni

- **Verification-first** — nothing is marked "done" without independent evidence (a separate verifier).
- **Transparent state** — canonical project state is plain Markdown on disk; SQLite only indexes/coordinates.
- **Safe by default** — no LLM spend unless you opt in; risky actions require approval *before* they run.
- **Self-improving** — a one-change loop adopts improvements only if the eval suite stays green (and auto-reverts regressions).
- **Reliable side effects** — multi-system actions run as sagas with idempotency keys and compensating rollback.
- **Zero dependencies** — Node ≥ 24 built-ins only (`node:sqlite`, `node:http`, `node:test`).

## Quick start

Requires **Node ≥ 24**. Nothing to install — no dependencies.

```bash
git clone https://github.com/deniscraciungabriel/omni.git
cd omni
node bin/omni.mjs init     # one-time setup (wakes the entity)
node bin/omni.mjs chat     # talk to it (interactive console)
```

New here? Read **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** — what you need (just Node) and how to use it.

## Use it

```bash
omni chat                                   # interactive console: /commands + natural language
omni say "how are things going?"            # one-shot
omni serve                                  # web dashboard + chat at http://localhost:7777
omni run [--workers N]                      # drain the task queue (N parallel workers)
omni eval | scan | evolve | status | model  # self-check · proactive scan · self-improve · status · brain
```

Inside the console, type naturally or use slash-commands (`/help`, `/status`, `/harness`, `/remember`, `/evolve`, …) with tab-completion and history.

## Specialized harnesses

Deterministic, multi-phase workflows with schema gates and verified reports. Sample inputs ship in `evals/fixtures/`.

| Harness | Command | What it does |
|---|---|---|
| Contract review | `omni harness contract <file.txt>` | classify → extract clauses → playbook risk review → report |
| Finance reporting | `omni harness finance <file.csv>` | ingest → reconcile vs ledger → variance analysis → board report |
| Incident recovery | `omni harness incident <file.json>` | triage → diagnose → **saga-backed** mitigation → postmortem |
| Research / science | `omni harness research <file.json>` | hypothesis → seeded experiment → **reproducibility check** → report |

## Connect a model (optional, the last step)

Point omni at any OpenAI-compatible `/v1/chat/completions` endpoint to enable free-form understanding:

```bash
export OMNI_LLM_ENDPOINT="http://localhost:11434/v1"   # Ollama / vLLM / LM Studio / llama.cpp / OpenAI …
export OMNI_LLM_MODEL="llama3.1"
node bin/omni.mjs model     # → connected via openai (llama3.1)
```

Details: **[docs/CONNECT_MODEL.md](docs/CONNECT_MODEL.md)**.

## Architecture

One strong execution path + an explicit task graph + a **separate** verifier + file-first memory + a human control plane. Pull-based workers claim tasks atomically (exactly-once) and run them through `goal → task graph → execute → verify → evidence → memory → learn`. Vendor specifics live behind adapters; the brain is a swappable provider.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full design.

```text
src/
  agent/        the entity: console, conversation, router brain, identity/memory
  llm/          model adapters (OpenAI-compatible, claude) — dormant until configured
  core/         goals, tasks, planner, queues, governance, worktrees, recurring, views
  worker/       pull-based execution loop (claim → execute → verify → learn)
  executors/    local · claude (gated) · contract · finance · incident · research
  verify/       independent verification methods
  effects/      idempotent effect layer + saga compensation
  improve/      one-change loop, workflow mining, proactive scan
  control-plane/ HTTP API + SSE + dashboard
evals/          isolated harness (45 scenarios) + runner
projects/       canonical per-project state (Markdown file packs)
```

## Testing

The eval suite is the test suite — capability, regression, safety, and failure-injection scenarios, run in an isolated environment:

```bash
node bin/omni.mjs eval     # 45/45
npm test                    # alias for the above
```

## Documentation

- [Getting started](docs/GETTING_STARTED.md) · [Connect a model](docs/CONNECT_MODEL.md) · [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](ROADMAP.md) · [Operator guide (AGENTS.md)](AGENTS.md) · [Contributing](CONTRIBUTING.md)

## Status

Actively built and verified end-to-end (45/45 evals). See [ROADMAP.md](ROADMAP.md) for what's done and what's next.

## License

[MIT](LICENSE).
