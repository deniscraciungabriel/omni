# WORKFLOW.md — how work flows and how the system grows

## The capability acquisition ladder
1. **Solve once** — complete the task, with human help if needed.
2. **Make it repeatable** — capture the trajectory (files, knowledge, run logs).
3. **Distill a playbook** — `playbooks/<name>.json` with typed tasks + verification.
4. **Add verification** — every task gets a `verification_plan`; no self-certification.
5. **Add an eval** — a scenario in `evals/harness.mjs` so regressions are caught.
6. **Wire momentum** — failures → `improve` queue; recurring checks → `recurring` queue.
7. **Earn autonomy** — trust rises per-domain from real outcomes; risky steps stay gated.

## Adding a fixed workflow (playbook)
A playbook is a fixed plan for standardized, reliability-sensitive work. Shape:
```json
{ "name":"x", "title":"...", "mode":"software|research|company|...",
  "tasks":[ { "key":"a", "title":"...", "kind":"command",
              "risk_level":"low",
              "spec": { "writes":[{"path":"f","contentLines":["..."]}],
                        "run":{"cmd":"..."}, "knowledge":{"key":"...","value":"..."} },
              "verify": { "method":"command", "cmd":"...", "expectExit":0 } },
            { "key":"b", "depends_on":["a"], ... } ] }
```
`depends_on` references other tasks by `key`; the planner wires real ids and ordering.

## Adding a verification method
Extend `src/verify/verify.mjs` with a new `case`. It must return
`{ passed: true|false|null, method, evidence:[...] }` (`null` = needs a human). Then add an eval
that proves it both passes a good result and **fails a bad one** (see `verifier_catches_bad_result`).

## Adding an execution engine
Implement `{ name, handles:[kinds], async execute(task, ctx) }` returning
`{ ok, exitCode, summary, artifacts?, cost?, tokens?, gated? }`. Register it in
`src/executors/index.mjs`. Keep side effects idempotent and bounded to `ctx.workspaceDir`.

## The reliability discipline (march of nines)
- If a step must happen every time, put it on **deterministic rails** (code/schema/gate), not a prompt.
- Validate at phase boundaries; loop on failure; generate templated outputs programmatically.
- Side effects carry idempotency keys; multi-system mutations need compensating actions (saga).
- Checkpoint per phase so a run resumes from the last good state. Trace trajectories, not just outcomes.

## Momentum (anti-stall)
Keep `now/next/blocked/improve/recurring` populated. After every substantial run leave: updated
state, visible evidence, ≥1 reusable ratchet, a clear next step, ≥1 improvement candidate.
When blocked: decompose the blocker and do non-blocked sidecar improvements in parallel.
When a failure repeats: add a guardrail/eval — don't just retry and hope.
