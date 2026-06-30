# omni — Roadmap & Momentum

_Living file. Update as reality changes. The system should never have all momentum queues empty._

## ✅ Milestone 1 — Prove the closed loop (DONE, verified 2026-06-29)
accept goal → task graph → claim → execute → verify → evidence → memory → visibility → learn.
Evidence: `hello-utility` playbook runs 3/3 tasks done with checksummed artifacts + independent
verification; `omni eval` = 7/7 (capability, regression, safety, failure-injection); control
plane serves live metrics/tasks/queues/approvals. Demonstrated with **zero LLM cost**.

## ✅ Milestone 2 — LLM planner + real execution behind governance (DONE, verified 2026-06-29)
- LLM planner decomposes freeform goals into typed task graphs (gated `claude` call, $0.067/plan).
- `claude` executor runs real coding tasks in **git worktree isolation** (per-project sandbox repo).
- Budget gate pauses (not fails) spend-incurring engines at the daily cap; cost/tokens captured.
- Hardened `node_test` verification (fails on zero tests). Independent verification in the worktree.
- **DoD met:** drove `clamp(n,lo,hi)` goal end-to-end with real `claude` — correct code, 5/5
  isolated tests pass, integrated into the project sandbox, omni root repo untouched (0 commits).
  Total real spend this session: **$0.33** / $5 cap. Evals: **12/12**.
- **Bug found + fixed mid-build (turned into 2 regression evals):** the first proof run polluted
  the omni *root* git repo because `ensureRepo` detected the ambient repo instead of creating an
  isolated nested one. Fixed (`repo_isolation_inside_ambient_repo`); also hardened the test
  false-pass where `node --test` exits 0 with no tests (`node_test_fails_on_zero_tests`).

## ✅ Milestone 3 — Control-plane altitude + recurring ops (DONE, verified 2026-06-29)
- **Approval UX**: every approval carries a computed blast-radius — what/why, reversibility,
  engine, side-effects, if-approved/if-denied. Shown in the dashboard inbox.
- **Altitude drill-down**: session → task → goal → project → portfolio, same state, via
  `/api/{task,goal,project,session}/:id` + `/api/portfolio` and a dashboard inspector pane.
- **Recurring ops engine**: durable DB-backed jobs + `omni cron-tick` (wire to host cron/`loop`).
  Seeded daily-eval, hourly-scan, daily-rollup; interval-respected (proven by eval + live run).
- **DoD met:** drove a multi-task LLM goal (isPalindrome) entirely via the dashboard HTTP API —
  LLM fan-out (impl → dependent memory task), real `claude` execution, dependency ordering,
  5/5 isolated tests, omni root untouched. Evals: **15/15** (3 new M3 guards). +$0.23 spend.
- Also fixed a real CLI bug (`--single` consumed the description) → boolean-flag handling.

## Milestone 4 — Self-improvement & external intelligence
- Background one-change loop: pick 1 hypothesis → change → eval slice → keep/revert → log.
- News-to-improvement pipeline: digest open-source agent architecture → ranked experiments.
- Workflow mining: repeated successful trajectories → new playbooks automatically.
- DoD: an improvement is adopted only after an eval delta proves it; a regression auto-reverts.

## ✅ Milestone 4 — Self-improvement & external intelligence (DONE, verified 2026-06-29)
- **One-change loop** (`src/improve/onechange.mjs`): baseline eval → one bounded change → eval →
  KEEP on gain, AUTO-REVERT on regression, with a file-snapshot safety net. Proven BOTH ways:
  a deliberately-bad change regressed evals 18→17 and was reverted **byte-identically** (checksum
  match); workflow mining was adopted 18→19 (kept). Logged in the `improvements` ledger.
- **Workflow mining** (`src/improve/mine.mjs`): detected the util+tests pattern (5× recurrence) and
  compiled a **parameterized** `coding-util` playbook + a generated locking eval. New capability:
  parameterized playbooks (`--playbook coding-util --spec "..."` with `{{spec}}` substitution).
- **External-intelligence digest** (`src/intel/digest.mjs`): ranks open-source signals by the
  high-value criteria (durable execution, checkpointing, typed contracts, memory, eval, sandbox,
  protocol), **filters thin wrappers** (scored -9, dropped), and queues ranked experiments.
- **DoD met:** improvements adopt only on a proven eval delta; regressions auto-revert. Evals: **19/19**
  (3 new M4 guards + 1 self-generated mined eval). Capability + test coverage now grow via the loop.

## ✅ Milestone 5 — First non-coding specialized harness (DONE, verified 2026-06-29)
- **Contract/document review harness** (`src/harnesses/contract/`): a FIXED-plan 5-phase state
  machine — classify → extract & categorize clauses → risk review vs a data-driven playbook →
  validation gate → programmatic templated report. Each phase leaves a schema-checked artifact
  (resumable/inspectable); a new `json_has` verifier enforces schemas at phase boundaries.
- Deterministic (zero LLM, zero external deps) — the reliability-critical pattern: rails +
  schemas + validation, not prompting. Output is a templated `report.md` (risk score, findings
  table, missing-clause + redline recommendations), regenerated identically every run.
- **Proven:** ran on a sample MSA → classified, 6 clauses, risk 4 (MEDIUM), correctly flagged
  uncapped liability + auto-renewal, all required clauses present. Evals: **23/23** (4 new M5
  guards incl. the schema-gate rejecting a malformed artifact). CLI: `omni harness contract <file>`.

## ✅ Milestone 6 — 2nd harness + LLM-enrichment gate (DONE, verified 2026-06-29)
- **Finance/reporting harness** (`src/harnesses/finance/`, `omni harness finance <file.csv>`):
  5-phase state machine — ingest → **reconcile vs ledger** → variance analysis → validation gate →
  board-style templated report. Proven on a Q1 dataset: caught a $1,500 reported-vs-ledger
  discrepancy (Payroll) + 2 material variances (Cloud +40%, Marketing +35.7%), risk MEDIUM.
- The harness CLI is now generic (`HARNESSES` registry); adding a harness = plan + executor + evals.
- **LLM-enrichment consistency gate** (`finance/enrich.mjs`): the reliable piece of "LLM judgment
  behind schema gates" — a narrative is rejected if it omits the risk level or contradicts the
  computed figures (claims clean reconciliation / no material variance when the numbers disagree).
- Evals: **28/28** (5 new M6 guards). Demonstrates the harness pattern generalizes across domains.

## ✅ Milestone 7 — Live LLM-behind-a-gate (DONE, verified 2026-06-30)
- **Self-correcting gated enrichment phase** on the finance harness (`omni harness finance
  <csv> --enrich`): optional Phase 6 calls real `claude` for an executive narrative, then runs
  the consistency gate; on failure it RETRIES with the gate's reasons as feedback (validation
  LOOP, not just a final check); publishes `narrative.md` only if it passes; never publishes a
  contradiction. Gated by `OMNI_ALLOW_CLAUDE` + a daily-budget guard; skips cleanly otherwise.
- Refactored a reusable `callClaude` engine helper (shared by the claude executor + harnesses).
- **Proven live:** real narrative passed the gate on attempt 1 ($0.065), accurate to the figures
  (risk MEDIUM, $67k/6.8% overspend, both material variances, the $1,500 Payroll discrepancy).
- Gated path proven by eval (skips cleanly, deterministic report stands). Evals: **29/29**.

## ✅ Milestone 8 — Idempotent effect layer + saga compensation (DONE, verified 2026-06-30)
- **Effect layer** (`src/effects/effects.mjs`): every side effect carries an idempotency key
  (committed effects never re-apply) and a compensating action. A **saga** applies steps in
  order; on ANY failure it compensates the already-committed steps in REVERSE — partial failure
  never leaves orphaned multi-system state. Durable ledger in `effects`/`sagas` tables.
- **Proven:** onboarding saga across 3 simulated systems (CRM/billing/email) — happy path
  commits all 3; failure at step 2 rolls back steps 0+1 (eval: fresh systems end 0/0/0, no
  orphans); re-applying a committed effect runs the side effect exactly once. Evals: **32/32**.
- CLI: `omni saga onboard <email> [--fail-at N]`, `omni effects [sagaId]`, `omni saga` (list).

## ✅ Milestone 9 — Incident/recovery harness (saga-backed) (DONE, verified 2026-06-30)
- **3rd harness** (`src/harnesses/incident/`, `omni harness incident <file.json>`): triage &
  severity → diagnose (runbook patterns) → **mitigate (runs remediation as a SAGA)** → verify
  recovery → postmortem. Integrates M8: a failed remediation rolls back instead of leaving infra
  half-fixed. CLI failure injection: `--fail-mitigation <action>`.
- **Proven:** bad-deploy incident → sev1 → rollback_deploy → RECOVERED; with `--fail-mitigation`
  the saga compensates → NOT RECOVERED (no half-applied infra). Evals: **36/36**.
- **Real bug found + fixed mid-build (now a regression eval):** mitigation idempotency keys were
  global (`[action, version]`), so a *second* incident's identical action was wrongly skipped as
  "already done". Fixed by scoping keys per incident instance (`incident_idempotency_scoped_per_incident`).

## ✅ Milestone 10 — Research/science harness (DONE, verified 2026-06-30)
- **4th harness** (`src/harnesses/research/`, `omni harness research <file.json>`): question &
  hypothesis → design + environment manifest (lineage) → run seeded trials → analyze with
  uncertainty (std + 95% CI) → **reproducibility check** (independent re-run from the same
  manifest; a claim isn't accepted unless it reproduces) → experiment report (claim→evidence).
- Deterministic seeded experiments (mulberry32 PRNG) make reproducibility genuinely verifiable.
- **Proven:** monte_carlo_pi → 3.14416 ± 0.0058 (abs err 0.0026), REPRODUCED (max diff 0); the
  reproduce check is proven to FAIL on tampered results. Evals: **40/40**.
- Harness library: contract · finance · incident · research.

## ✅ Milestone 11 — Controlled parallelism on one machine (DONE, verified 2026-06-30)
- `omni run --workers N` spawns N concurrent worker PROCESSES that drain the shared WAL queue;
  atomic leased claiming guarantees each task runs exactly once. `omni demo-parallel --count N`
  generates independent tasks for the demo.
- **Proven:** 8 tasks (~0.3s each) — sequential **2.63s**, 4 workers **0.72s** (~3.6× speedup),
  with a built-in double-execution check: **PASS** (every task ran exactly once). New regression
  eval `concurrent_claim_no_duplicates` (12 tasks, interleaved workers, no duplicate claims).
  Evals: **41/41**. This validates the pull-based execution fabric under real concurrency.

## ✅ Milestone 12–14 — The entity + model adapter (DONE, verified 2026-06-30)
omni becomes **Omni**, an entity you converse with that does work, remembers, and evolves —
built so that **connecting a model is the only remaining step**.
- **Model adapter layer** (`src/llm/`): pluggable brain behind an OpenAI-compatible interface
  (`openai.mjs` works with Ollama/vLLM/LM Studio/llama.cpp/OpenRouter/OpenAI) + a `claude` brain;
  `getProvider()` auto-selects, dormant until configured. Zero deps (global fetch).
- **The entity** (`src/agent/`): persistent identity + persona; a deterministic **router brain**
  that maps natural language to every real capability (status, harnesses, sagas, remember/recall,
  scan, evolve, intel, evals); durable conversation memory; `omni chat` / `omni say` + a
  dashboard chat panel + `/api/say`.
- **Memory of you + self**: user profile + preference memory; the entity's self-notes evolve via
  the one-change loop ("evolve" intent). State isolated via `OMNI_STATE` (real bug found+fixed).
- **Proven:** talk to it → it runs harnesses, remembers/recalls, reports status — all with NO
  model. Evals: **45/45** (router intents, memory, dormant-model contract, adapter shape).
- **THE LAST STEP:** set `OMNI_LLM_ENDPOINT` + `OMNI_LLM_MODEL` → free-form understanding turns
  on. See `docs/CONNECT_MODEL.md`. No further code required.

## Optional later milestones (post-model)
- Multi-MACHINE same-project orchestration (hub + remote workers, file-pack sync).
- Model-driven tool-calling (the connected model invoking router skills as tools).
- LLM-planner JSON-retry-before-fallback; science replication queue.

## Ops note: wiring recurring ops to the host (opt-in, safe-by-default)
The internal scheduler is built; to fire automatically, wire `node bin/omni.mjs cron-tick` to
host cron or the `loop` skill. The self-improvement loop (`mine`/`improve`) is intentionally NOT
auto-recurring — it modifies the repo, so it stays a deliberate, operator-invoked action.

## Live momentum (see `omni queues` for current)
- **now**: M1–M14 done & verified. The entity is complete on a deterministic brain.
- **THE LAST STEP (yours)**: connect a model — `OMNI_LLM_ENDPOINT` + `OMNI_LLM_MODEL`
  (OpenAI-compatible). See `docs/CONNECT_MODEL.md`. Everything else is built + eval-covered.
- **optional next (post-model)**: model-driven tool-calling; multi-machine; real user workflows.
- **blocked**: (none) — real `claude` execution is proven; keep it gated behind `OMNI_ALLOW_CLAUDE=1`.
- **improve**: ranked external-intelligence experiments (LangGraph/Temporal checkpoint-replay,
  Letta retrieval, E2B sandbox); compensating actions for multi-system side effects.
- **recurring**: daily eval + pass-rate delta; proactive scan; cost/intervention rollup.
- **recurring**: daily eval + pass-rate delta; proactive scan; cost/intervention rollup.
