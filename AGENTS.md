# AGENTS.md — operator guide for omni

Portable instructions for any compatible agent (or human) operating this repo. omni is a
durable, observable, self-improving agentic operating system. Read this before acting.

## The one rule
**Files are canonical. The DB is an index.** Any project under `projects/<id>/` must be
continuable from its folder alone. Read the file pack before acting; update it during work.

## Core loop (never skip a stage)
`goal -> task graph -> claim -> execute -> verify -> evidence -> memory -> visibility -> learn`
A task is **never** marked done without independent verification + recorded evidence.

## The entity (Omni)
omni is exposed as **Omni**, an entity you converse with (`src/agent/`). `omni chat` / `omni say
"<msg>"` / dashboard chat panel / `POST /api/say`. A deterministic **router brain** (`router.mjs`)
maps natural language → real capabilities; works with NO model. Connecting an OpenAI-compatible
model (`src/llm/`, `docs/CONNECT_MODEL.md`) is the last step and adds free-form understanding.
Identity + user memory: `src/agent/identity.mjs` (→ `state/entity.json`, `state/user-profile.json`).

## How to operate
```
node bin/omni.mjs init                      # one-time: schema + queues + wake the entity
node bin/omni.mjs goal --playbook hello-utility   # deterministic demo of the whole loop
node bin/omni.mjs goal "fix the failing test"     # freeform -> gated LLM task
node bin/omni.mjs run                        # drain the queue: claim/execute/verify/learn
node bin/omni.mjs status                     # human-readable mirror + committed metrics
node bin/omni.mjs eval                       # isolated capability/regression/safety suite
node bin/omni.mjs serve                      # control-plane dashboard + API + live feed
node bin/omni.mjs scan                       # proactive: turn stalls into momentum items
node bin/omni.mjs cron-tick                  # run due recurring jobs (wire to host cron/loop)
node bin/omni.mjs recurring [add|seed]       # list/add recurring ops
node bin/omni.mjs harness contract <file>    # specialized 5-phase contract-review harness
node bin/omni.mjs mine | improve [--bad]     # self-improvement: mine workflows / one-change loop
node bin/omni.mjs intel | improvements       # external-intel digest / improvement ledger
node bin/omni.mjs approvals|approve <id>|deny <id>
node bin/omni.mjs queues | trust | knowledge "<q>"
```

## Altitude (drill-down) API — same state at every zoom level
`/api/portfolio` · `/api/project/:id` · `/api/goal/:id` · `/api/task/:id` · `/api/session/:id`
(session→task→goal→project→portfolio). Approvals carry a computed blast-radius
(what/why/reversible/side-effects). The dashboard inspector pane renders these on click.

## Safety posture (do not weaken without recording a decision)
- Default executor is `local` (deterministic, **zero LLM cost**).
- The `claude` executor (real `claude -p` subprocess; spends money, takes actions) is **gated**:
  it only runs when `OMNI_ALLOW_CLAUDE=1`. Risk `high`/`critical` tasks also require an
  approval row before dispatch (`ensureApproval`, deny-first on destructive verbs).

## Where things live
- `src/core/` task graph, goals, planner, queues, governance (approvals/budgets/trust)
- `src/worker/` the closed-loop worker (claim->execute->verify->evidence->learn)
- `src/executors/` pluggable engines: `local`, `claude` (gated), `echo` (eval)
- `src/verify/` independent verifier (file_exists, command, checksum, knowledge_present, ...)
- `src/memory/` file-pack writer + knowledge index
- `src/improve/` inline learning + proactive scan + one-change loop scaffold
- `src/control-plane/` HTTP API + SSE + dashboard
- `playbooks/*.json` fixed plans (standardized, repeatable workflows)
- `evals/` isolated harness (temp DB + temp projects) + runner that records to the real DB

## Adding capability (the ladder)
1. Solve once → 2. make repeatable → 3. distill a **playbook** → 4. add **verification** →
5. add an **eval scenario** (`evals/harness.mjs`) → 6. wire to momentum queues. Every success
should leave a reusable ratchet; every twice-repeated failure should become an eval/guardrail.

## Conventions
- New task kinds need: an executor that `handles` them, a verification method, and an eval.
- Side effects need an idempotency key (`src/ids.mjs`) and should be reversible or approved.
- Keep the orchestrator lean; isolate narrow work; prefer cheaper engines when sufficient.
