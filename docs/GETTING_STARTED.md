# Getting started with omni (the entity, "Omni")

A practical guide: what you need before you start, and how to actually use it.

---

## TL;DR

```bash
node bin/omni.mjs init     # one-time setup (wakes the entity)
node bin/omni.mjs chat     # talk to it
```

You need **nothing** to start — no API keys, no endpoints, no accounts. Omni runs today on a
deterministic brain and does real work. A model is **optional** and is the *last* step (it only
adds free-form natural-language understanding). See **[Connecting a model](#5-optional-connect-a-model-the-last-step)**.

---

## 1. What's required before you start

| Thing | Required? | Notes |
|---|---|---|
| **Node.js ≥ 24** | ✅ yes | the only hard requirement. Check: `node --version` |
| npm install | ❌ no | **zero dependencies** — nothing to install |
| API key | ❌ no | not needed unless you connect a hosted model later |
| Endpoint / server | ❌ no | only if you connect a model later |
| `git` | optional | enables worktree isolation for coding tasks; not needed otherwise |
| `claude` CLI | optional | one way to give it a "brain"; an open-source model is the intended path |

So: **install Node 24, that's it.** Everything below works with no further setup.

> Already have Node? Then there is genuinely nothing missing — run `init` and go.

---

## 2. First run

```bash
git clone https://github.com/deniscraciungabriel/omni.git
cd omni
node bin/omni.mjs init
```
This creates `state/` (the local database + the entity's identity), seeds the momentum queues and
recurring jobs, and prints `entity "Omni" is awake.`

Optional convenience — add an alias so you can type `omni` anywhere:
```bash
alias omni="node $(pwd)/bin/omni.mjs"
# (add to ~/.zshrc to make it permanent)
```
The rest of this doc assumes `omni` = `node bin/omni.mjs`.

---

## 3. Talk to it (the main way to use it)

```bash
omni chat        # interactive console (banner, slash-commands, tab-complete, history)
```

Inside the console you can **type naturally** or use **/commands** (tab-completes):

| command | what it does |
|---|---|
| `/help` | list everything |
| `/status` | live snapshot (tasks, evals, spend, what's next) |
| `/model` | brain status + how to connect a model |
| `/harness <type> <file>` | run a specialized harness (see §4) |
| `/remember <text>` · `/recall <q>` | durable memory |
| `/tasks` · `/queues` · `/identity` · `/history` | inspect state |
| `/scan` · `/evolve` · `/intel` · `/eval` | keep itself healthy & improving |
| `/saga onboard <email>` | run a rollback-safe multi-step workflow |
| `/name <you>` · `/clear` · `/exit` | misc |

Natural language works too — it maps to the same capabilities:
```
you › how are things going?
you › review this contract evals/fixtures/sample-msa.txt
you › remember my deploy window is Tuesday mornings
you › what do you know about deploy?
you › onboard alice@acme.com
```

**One-shot (no REPL)** — great for scripts:
```bash
omni say "how are things going?"
omni say "run the finance report on evals/fixtures/q1-actuals.csv"
```

**Web surface** — same entity, plus dashboards:
```bash
omni serve        # http://localhost:7777 — chat panel + live task board + approvals + drill-down
```

---

## 4. The four specialized harnesses (try them now)

Each is a deterministic, multi-phase workflow with a verified report. Sample inputs are in
`evals/fixtures/`:

```bash
omni harness contract evals/fixtures/sample-msa.txt        # clause extraction + risk review
omni harness finance  evals/fixtures/q1-actuals.csv        # variance + ledger reconciliation
omni harness incident evals/fixtures/incident-checkout.json   # triage → saga recovery → postmortem
omni harness research evals/fixtures/experiment-pi.json    # seeded experiment + reproducibility

# add --enrich to the finance one to (optionally) get an LLM narrative (needs a model)
omni harness finance evals/fixtures/q1-actuals.csv --enrich
```
The generated report prints to the terminal and is saved under `projects/<id>/artifacts/report.md`.

---

## 5. (Optional) Connect a model — the last step

This is the only thing that needs external config, and it's **optional**. It turns on free-form
understanding (answering open-ended requests that don't map to a built-in skill).

Point omni at any **OpenAI-compatible** `/v1/chat/completions` endpoint:

```bash
# Example: Ollama (open-source, local)
#   ollama serve   &&   ollama pull llama3.1
export OMNI_LLM_ENDPOINT="http://localhost:11434/v1"
export OMNI_LLM_MODEL="llama3.1"
export OMNI_LLM_API_KEY=""          # only if your server requires one

omni model     # should now say: connected via openai (llama3.1)
omni chat      # now understands open-ended requests
```
Works with **Ollama, vLLM, LM Studio, llama.cpp server, OpenRouter, OpenAI**, etc.
Full details + more server examples: **`docs/CONNECT_MODEL.md`**.

> Quick brain for testing without a server: `export OMNI_ALLOW_CLAUDE=1` (uses the local `claude` CLI).

---

## 6. Environment variables (all optional)

| var | default | purpose |
|---|---|---|
| `OMNI_LLM_ENDPOINT` | — | OpenAI-compatible base URL (connect a model) |
| `OMNI_LLM_MODEL` | — | model name your server serves |
| `OMNI_LLM_API_KEY` | — | bearer token if the endpoint needs one |
| `OMNI_LLM_PROVIDER` | `auto` | `auto` · `openai` · `claude` · `none` |
| `OMNI_LLM_MAX_TOKENS` / `OMNI_LLM_TEMPERATURE` | 1024 / 0.3 | generation params |
| `OMNI_ENTITY_NAME` | `Omni` | rename the entity |
| `OMNI_ALLOW_CLAUDE` | `0` | `1` = allow real `claude` execution (coding tasks + claude brain). **Costs money.** |
| `OMNI_DAILY_COST_LIMIT` | `5` | USD/day soft cap on LLM spend |
| `OMNI_PORT` | `7777` | dashboard port |
| `OMNI_STATE` / `OMNI_DB` / `OMNI_PROJECTS` | `state/…` | relocate local state |

Nothing here is required to start. Set them only when you want the corresponding feature.

---

## 7. Keeping it healthy & evolving

```bash
omni eval        # run the 45-eval self-check (capability + regression + safety)
omni scan        # proactively surface blocked/stale work
omni evolve      # one-change self-improvement loop (keeps changes only if evals stay green)
omni cron-tick   # run due recurring jobs (daily eval, scan, metric rollup)
```
To make recurring jobs fire automatically, wire `omni cron-tick` into cron or a loop, e.g.:
```bash
# crontab -e
*/30 * * * * cd /path/to/omni && node bin/omni.mjs cron-tick >/dev/null 2>&1
```

---

## 8. Where things live (so you can trust it)

- `state/` — local SQLite DB + the entity's identity (`entity.json`) + your profile
  (`user-profile.json`). Delete `state/` to fully reset; re-run `init`.
- `projects/<id>/` — **canonical, human-readable** state for each piece of work: `plan.md`,
  `tasks.md`, `knowledge.md`, `decisions.md`, `status.md`, `handoff.md`, `artifacts/`, `runs/`.
- `docs/` — `CONNECT_MODEL.md`, `ARCHITECTURE.md`. `ROADMAP.md` / `OPERATING_SUMMARY.md` at root.

**Safety defaults:** no LLM spend unless you opt in (`OMNI_ALLOW_CLAUDE=1`); risky actions need
approval before they run; everything is verified before it's called "done."

---

## 9. Cheat sheet

```bash
omni init                                   # one-time
omni chat                                   # talk to it (console)
omni say "<anything>"                        # one-shot
omni serve                                  # web dashboard + chat
omni harness <contract|finance|incident|research> <file>
omni saga onboard <email>                   # rollback-safe workflow
omni status | tasks | queues | model | identity
omni eval | scan | evolve | intel | improvements
omni run [--workers N]                      # drain the task queue (N parallel workers)
# connect a model (optional, last step):
OMNI_LLM_ENDPOINT=http://localhost:11434/v1 OMNI_LLM_MODEL=llama3.1 omni chat
```

That's everything you need. Start with `omni init` → `omni chat`.
