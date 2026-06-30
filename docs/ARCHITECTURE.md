# omni — Architecture

## The bet
One strong generalist execution path + an explicit **task graph** + a **separate verifier** +
**durable file-first memory** + a **human control plane**. NOT a swarm of chatty agents.
Controlled parallelism and multi-agent patterns are added only after the single-agent baseline
is reliable. Claude Code (`claude -p`) is a *replaceable execution engine* behind an adapter.

## Layers
| Layer | Module | Role |
|---|---|---|
| Control plane | `src/control-plane/` | REST + SSE + dashboard; the human operating surface |
| Task graph | `src/core/tasks.mjs` | typed tasks, dep-aware eligibility, atomic leased claiming |
| Goals/plan | `src/core/goals.mjs`, `planner.mjs` | goal → task graph (playbook=fixed / freeform=dynamic) |
| Execution | `src/worker/worker.mjs` | pull-based loop: approval→execute→verify→evidence→learn |
| Executors | `src/executors/` | `local` (default/safe), `claude` (gated), `echo` (eval) |
| Verifier | `src/verify/verify.mjs` | independent checks → evidence (never self-certify) |
| Memory | `src/memory/memory.mjs` | file pack (canonical) + knowledge index (DB) |
| Governance | `src/core/governance.mjs` | approvals, budgets, per-domain trust |
| Momentum | `src/core/queues.mjs` | now/next/blocked/improve/recurring (anti-stall) |
| Learning | `src/improve/` | inline learning, proactive scan, one-change loop |
| Evals | `evals/` | isolated harness + runner recording to the real DB |

## State model (transparent)
- **Canonical = files** under `projects/<id>/`: `project.md, plan.md, tasks.md, knowledge.md,
  decisions.md, status.md, handoff.md, FAILURE.md, artifacts/, runs/<session>/evidence.json`.
  Any compatible agent can continue from the folder alone.
- **Operational = SQLite** (`state/omni.db`, WAL): goals, tasks, sessions, events, metrics,
  approvals, budgets, trust, incidents, evals, knowledge index, queue mirror. Indexing +
  coordination + visibility only — it mirrors the files, it does not replace them.

## Task lifecycle
`pending → claimed → running → verifying → done`
branches: `needs_approval` (risk gate / verification needs human / engine gated),
`pending` again (retry once), `failed` (terminal → FAILURE.md + learning ratchet), `cancelled`.
Claiming is an atomic compare-and-set with a **leased** lock, so duplicate execution is
impossible and crashed workers' tasks become reclaimable.

## Reliability properties (proven by evals)
- atomic claim (no double execution) · dependency ordering · approval gate before side effects
- verifier independently catches a "lying" execution · failure injection → learning ratchet
- full playbook end-to-end (real files + `node --test`)

## Execution engines (adapters)
`pickExecutor(task)` routes by `task.kind` (override via `spec.executor`). `local` performs
deterministic file writes + shell commands + knowledge writes. `claude` wraps `claude -p
--output-format json` in the project workspace, capturing transcript + cost/tokens; **gated**
by `OMNI_ALLOW_CLAUDE` and approval policy. New engines implement `{name, handles, execute}`.

## Verification methods
`none · file_exists · file_contains · checksum · command(expectExit) · knowledge_present ·
manual(→ needs human)`. Declared per task in `verification_plan`. Evidence is persisted to the
run dir and the task row.

## Governance
- **Approvals** gate `high`/`critical` risk *before* dispatch (deny-first on destructive verbs).
- **Budgets** tracked per task/goal/day; soft daily cost guardrail for LLM work.
- **Trust** is per-domain and earned from outcomes (`supervised→guided→autonomous`).

## Portability
Zero external deps; vendor specifics live behind the executor adapter. State formats are plain
JSON/markdown/SQLite. The same core scales later to hub-and-worker and multi-machine without
changing the task/file/verification contracts.

## Specialized harnesses (M5+)
A specialized harness is a FIXED-plan state machine for repeated, reliability-critical work:
explicit phases, a schema-checked artifact per phase, validation gates, and programmatic
templated output (per the march-of-nines doctrine — codify what must happen every time).
It reuses the task graph (one task per phase), worker loop, verifier, evidence, and memory.
- `src/harnesses/contract/` — contract review: classify → extract → review (playbook rules) →
  validate → synthesize. `logic.mjs` (pure phases) · `playbook.json` (data-driven rules) ·
  `plan.mjs` (5-task graph). Executor `src/executors/contract.mjs`. Verifier method `json_has`
  enforces schemas at phase boundaries. CLI: `omni harness contract <file>`.

## M4 additions (self-improvement)
- `src/improve/onechange.mjs` — keep-on-gain / auto-revert-on-regression loop (file-snapshot
  safety net) + `improvements` ledger. `src/improve/mine.mjs` — workflow mining → parameterized
  playbook + self-generated eval. `src/intel/digest.mjs` — external-intelligence ranking.
  Evals auto-load from `evals/scenarios/*.mjs` so the loop can add coverage by dropping a file.

## M2/M3 additions
- `src/core/worktree.mjs` — git worktree isolation (per-project sandbox repo; squash-merge on
  success; diff captured as evidence). `src/core/planner.mjs` — `planFreeformLLM` (gated LLM
  decomposition with fallback). Verifier method `node_test` (fails on zero tests).
- `src/core/recurring.mjs` — durable recurring-ops engine (`cron-tick`). `src/core/views.mjs` —
  altitude assembly (session→task→goal→project→portfolio). `governance.computeBlastRadius` —
  approval UX. Server exposes `/api/{task,goal,project,session}/:id`, `/api/portfolio`, `/api/cron-tick`.

## Deferred (honest gaps)
Browser/desktop automation reliability stack; multi-machine orchestration; encrypted secret
store; the background one-change eval loop (scaffolded in `src/improve/`, not yet autonomous —
M4); external-intelligence digest (M4); auto-wiring recurring ops to host cron (opt-in). See `ROADMAP.md`.
