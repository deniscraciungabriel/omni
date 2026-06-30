# Changelog

All notable changes to this project are documented here. See [ROADMAP.md](ROADMAP.md) for the
milestone-by-milestone detail and what's next.

## [Unreleased]

### Added
- **The entity (Omni)** — a conversational agent (`omni chat` / `omni say` / dashboard chat) with
  a deterministic router brain, durable conversation + preference memory, and self-evolution.
- **Model adapter layer** — pluggable, OpenAI-compatible brain (Ollama/vLLM/LM Studio/…), dormant
  until configured. Connecting a model is a config-only step.
- **Four specialized harnesses** — contract review, finance reporting, incident recovery (saga-backed),
  and research/science (with reproducibility checks).
- **Idempotent effect layer + sagas** — multi-system side effects with compensating rollback.
- **Self-improvement** — one-change loop (keep-or-auto-revert on eval delta), workflow mining,
  external-intelligence digest.
- **Control plane** — HTTP API + SSE + dashboard with altitude drill-down and blast-radius approvals.
- **Controlled parallelism** — `omni run --workers N` with atomic, exactly-once task claiming.
- **45 evals** covering capability, regression, safety, and failure injection.

### Notes
- Zero runtime dependencies (Node ≥ 24 standard library only).
- Safe by default: no LLM spend or risky side effects without explicit opt-in / approval.
