# OMNI — Implementation Contract

_Authored at bootstrap. Versioned like code. Update when reality changes._

## Mission
Build a durable, observable, self-improving agentic operating system that accepts goals,
turns them into verified work, keeps memory over time, and safely expands toward general
computer work — with Claude Code as a replaceable execution engine.

## Runtime profile (discovered, not assumed)
| Capability | State | Notes |
|---|---|---|
| repo read/write | yes | local filesystem, full access |
| shell | yes | zsh on macOS arm64 |
| filesystem search/edit | yes | |
| git | yes (binary) | workspace NOT yet a git repo; `gh` absent |
| network | yes | node fetch + WebFetch/WebSearch tools |
| package install | yes | npm 11; **chosen: zero external deps** |
| local database | yes | `node:sqlite` built in (WAL) |
| browser control | partial | not native; via future adapter / MCP |
| screenshot/vision | partial | Read tool can view images |
| desktop input | no | deferred |
| tool calling / subagents | yes | host = Claude Code (Agent tool, Tasks, MCP) |
| background / scheduled exec | yes | host crons + node workers |
| persistent storage | yes | filesystem + sqlite |
| UI/dashboard | yes | `node:http` dashboard (M3) |
| secret management | partial | env vars; encrypt-at-rest deferred |
| approvals/interruption | yes | built into task lifecycle |
| multi-machine | deferred | architecture supports hub/worker later |
| LLM execution engine | yes | `claude -p` v2.1.191, **gated by default** |

## Decisions (with tradeoffs)
1. **Harness-wrapper mode.** Wrap Claude Code instead of rebuilding an agent loop.
   _Tradeoff:_ depends on `claude` for open-ended work; mitigated by a pluggable executor
   interface (`local`/`claude`/`echo`) so the engine is swappable.
2. **Zero external dependencies.** Node built-ins only.
   _Tradeoff:_ less off-the-shelf power vs. maximal portability, instant runnability, no
   supply-chain/install risk. Re-evaluate if a capability genuinely requires a lib.
3. **Files canonical, DB operational.** Projects continue from the folder alone; DB indexes
   for coordination + visibility. _Tradeoff:_ dual-write cost vs. portability + transparency.
4. **Safe-by-default execution.** `local` deterministic executor is the default; real LLM
   execution (`claude`) is gated behind `OMNI_ALLOW_CLAUDE=1` + approval policy.
   _Tradeoff:_ slower path to autonomous coding vs. no surprise spend / no surprise actions.
5. **Verification separated from execution.** A task is never self-certified.

## First milestone
The full closed loop, demonstrated deterministically (no LLM) via a playbook:
accept goal -> task graph -> claim -> execute -> verify -> evidence -> memory -> visibility -> learn.

## Non-goals for v1
- Multi-agent swarms; multi-machine orchestration; desktop automation; a polished web UI.
- Autonomous spend. Browser automation reliability stack. These are later milestones.

## Constraints
- No surprise cost: LLM calls gated. No destructive actions without approval policy pass.
- Everything inspectable: state in files + queryable DB; every run leaves an evidence trail.

## Safety posture
Supervised by default. Risk tiers gate side effects BEFORE execution. Trust is earned per
domain from real outcomes. Budgets tracked per task/goal/day. Incidents on boundary crossings.

## Proof-of-progress metrics (tracked from day one)
tasks_completed, tasks_verified, median_time_to_completion, cost_per_successful_task,
intervention_rate, retry_rate, eval_pass_rate, repeat_run_stability, memory_reuse_rate,
+ momentum metrics (time-to-next-task, reusable-assets-per-milestone, failures-converted-to-evals).

## Verification strategy
Each non-trivial task carries a `verification_plan` (command exit code, artifact existence +
checksum, file-content match, or human approval). Evidence is persisted to `runs/` + DB.
The eval harness (`node:test`) provides capability + regression coverage offline.
