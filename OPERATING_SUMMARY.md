# OMNI — Operating Summary (re-read this during long runs)

> Compact self-summary per the Reader Contract. If I drift into chat-only behavior,
> stop and return to: files, tasks, verification, evidence, implementation.

## What this is
**omni** = a durable, observable, self-improving agentic operating system for general
computer work. Built in **harness-wrapper mode**: Claude Code (`claude -p` headless) is the
*replaceable execution engine*; omni is the file-first project OS + control plane around it.

## North star
Prove and harden the closed loop, then expand breadth:
`goal -> task graph -> claim -> execute -> verify -> evidence -> memory -> visibility -> learn`

## Default architecture (the non-negotiable bet)
- ONE strong generalist execution path + explicit task graph + separate verifier + durable
  memory + a human control plane. NOT a swarm of chatty agents.
- Add multi-agent / parallelism only after the single-agent baseline is reliable.

## Stack (inferred from runtime — zero external deps)
- Node v24 ESM JavaScript. Built-ins only:
  - `node:sqlite` (WAL) = operational/coordination index (tasks, events, metrics, ...).
  - `node:test` = eval harness.
  - `node:http` = control-plane REST + SSE + dashboard.
- **Files are canonical project state**; SQLite mirrors/indexes for coordination + visibility.

## State split (transparent, portable)
- Canonical per-project state = markdown files under `projects/<id>/`:
  `project.md, plan.md, tasks.md, knowledge.md, decisions.md, status.md, handoff.md,
   FAILURE.md, artifacts/, runs/`. Any compatible agent can continue from the folder alone.
- SQLite (`state/omni.db`) = tasks, goals, sessions, events, metrics, approvals, budgets,
  trust, incidents, evals, knowledge index, momentum queues.

## Safety posture (current)
- Default executor = `local` (deterministic command/file tasks, **zero LLM cost**).
- `claude` executor (real `claude -p` subprocess, costs money) is **gated**: only runs when
  `OMNI_ALLOW_CLAUDE=1` AND task risk passes approval policy. Shadow-mode by default.
- Verification is a SEPARATE concern from execution. Nothing is "done" without evidence.

## Momentum queues (never leave all five empty)
`now` / `next` / `blocked` / `improve` / `recurring` — mirrored in DB + `state/queues.json`.

## Milestone 1 — DONE & verified
full loop end-to-end via `hello-utility` playbook (no LLM) + control-plane dashboard + evals.

## Milestone 2 — DONE & verified (real LLM execution)
LLM planner decomposes freeform goals → `claude` executor runs coding tasks in **git worktree
isolation** (per-project sandbox repo; omni root never touched) → hardened `node_test` verify
(fails on 0 tests) → budget gate + cost capture. Proven on a real `clamp()` goal, ~$0.33 spend
under $5 cap, **12/12 evals**. Enable real execution with `OMNI_ALLOW_CLAUDE=1`.

## Milestone 3 — DONE & verified (control-plane altitude + recurring ops)
Approval UX with blast-radius (what/why/reversible/side-effects) · altitude drill-down
session→task→goal→project→portfolio (`/api/*` + dashboard inspector) · recurring engine
(`omni cron-tick`, wire to host cron/loop). DoD: drove a multi-task LLM goal (fan-out +
dependency ordering) entirely via the dashboard API with real `claude`. **15/15 evals.**

## Milestone 4 — DONE & verified (self-improvement engine)
One-change loop (`omni improve`): baseline eval → 1 bounded change → eval → KEEP on gain /
AUTO-REVERT on regression (file-snapshot safety net). Proven both ways: bad change reverted
byte-identically; mining adopted 18→19. Workflow mining (`omni mine`) → parameterized
`coding-util` playbook + self-generated eval. External-intel digest (`omni intel`) → ranked
experiments, thin wrappers filtered. **19/19 evals.** Improvement ledger: `omni improvements`.

## Milestone 5 — DONE & verified (first specialized harness)
Contract/document review harness (`omni harness contract <file>`): a 5-phase deterministic
state machine (classify → extract clauses → playbook risk review → validation gate → templated
report). Schemas at phase boundaries via the new `json_has` verifier; artifact trail per phase
(resumable). Zero LLM, zero deps. Proven on a sample MSA (risk MEDIUM, uncapped-liability +
auto-renew flagged). **23/23 evals.** This proves the specialized-harness pattern beyond coding.

## Milestone 6 — DONE & verified (2nd harness + LLM-enrichment gate)
Finance/reporting harness (`omni harness finance <file.csv>`): ingest → reconcile-vs-ledger →
variance analysis → validation gate → board report. Proven on Q1 data (caught a $1,500 ledger
discrepancy + 2 material variances). Generic harness CLI registry. LLM-enrichment consistency
gate (`finance/enrich.mjs`) rejects narratives that contradict the computed numbers. **28/28 evals.**

## Milestone 7 — DONE & verified (live LLM behind a self-correcting gate)
Finance harness optional Phase 6 (`--enrich`): real gated `claude` narrative → consistency gate →
RETRY-with-feedback on failure → publish `narrative.md` only if it passes; never a contradiction.
Budget-guarded; skips cleanly when gated. Proven live (passed attempt 1, $0.065, accurate to the
figures). Reusable `callClaude` helper. **29/29 evals.**

## Milestone 8 — DONE & verified (idempotent effect layer + sagas)
`src/effects/`: every side effect has an idempotency key (no double-apply) + a compensating
action. Sagas apply steps in order; on failure they compensate committed steps in REVERSE — no
orphaned multi-system state. Proven on a 3-system onboarding saga (commit-all / rollback-on-fail /
idempotent-replay). `omni saga onboard <email> [--fail-at N]` · `omni effects`. **32/32 evals.**

## Milestone 9 — DONE & verified (incident/recovery harness, saga-backed)
3rd harness (`omni harness incident <file.json>`): triage → diagnose (runbook) → mitigate (runs
remediation as a SAGA, rolls back on failure) → verify recovery → postmortem. `--fail-mitigation
<action>` demos rollback. Caught + fixed a real idempotency-scoping bug (keys now per-incident).
Harness library: contract · finance · incident. **36/36 evals.**

## Milestone 10 — DONE & verified (research/science harness)
4th harness (`omni harness research <file.json>`): hypothesis → design+manifest (lineage) → run
seeded trials → analyze w/ uncertainty (std+CI) → REPRODUCIBILITY check (independent rerun from
manifest) → report. Deterministic seeded experiments. Proven: monte_carlo_pi REPRODUCED (max diff
0); reproduce-check catches tampered results. Harness library: contract·finance·incident·research.
**40/40 evals.**

## Milestone 11 — DONE & verified (controlled parallelism, one machine)
`omni run --workers N` drains the shared WAL queue with N concurrent worker PROCESSES; atomic
leased claiming = each task runs exactly once. Proven: 8 tasks 2.63s→0.72s (~3.6× w/ 4 workers).

## Milestones 12–14 — DONE & verified (THE ENTITY + model adapter)
omni is now **Omni**, an entity you talk to (`omni chat` / `omni say` / dashboard chat panel).
Deterministic router brain maps natural language → every capability; durable conversation +
preference memory; evolves via the one-change loop. Model adapter (`src/llm/`) is OpenAI-compatible
and **dormant until configured**. **45/45 evals.**

## THE ONLY REMAINING STEP (yours)
Connect a model: `OMNI_LLM_ENDPOINT` + `OMNI_LLM_MODEL` (OpenAI-compatible — Ollama/vLLM/LM
Studio/…). Then free-form understanding turns on. See `docs/CONNECT_MODEL.md`. No code changes.

## Harness library so far
`omni harness contract <file.txt>` · `omni harness finance <file.csv>` — both are fixed-plan
5-phase deterministic state machines with `json_has` schema gates and templated reports.

## Key commands
`omni init` · `omni goal "<desc>" [--playbook X]` · `omni run` · `omni tick` ·
`omni status` · `omni serve` · `omni eval` · `omni queues`

## Runtime facts
macOS arm64, 18 cores, 64GB. Node 24.15. sqlite3/jq/git present; gh/tmux absent.
claude 2.1.191 at /opt/homebrew/bin/claude. Workspace started EMPTY + non-git.
