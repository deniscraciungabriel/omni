# Contributing to omni

Thanks for your interest. omni is intentionally **dependency-free** and **verification-first** —
contributions should respect both.

## Principles

- **Zero runtime dependencies.** Use the Node standard library (`node:*`). If you think a dependency
  is truly necessary, open an issue to discuss it first.
- **Verification-first.** Every new capability needs an eval. A change is not complete until the
  suite is green.
- **Files are canonical.** Durable project state lives in Markdown under `projects/<id>/`; the
  SQLite database only indexes and coordinates.
- **Safe by default.** No LLM spend or side effects without an explicit opt-in / approval.

## Workflow

1. Make your change.
2. Add or update an eval scenario in `evals/harness.mjs` (or drop a file in `evals/scenarios/`)
   that proves it — and, for a bug fix, that *fails* before the fix.
3. Run the suite:
   ```bash
   node bin/omni.mjs eval     # must be all green
   ```
4. Keep edits in the style of the surrounding code (small, focused, well-commented at the seams).

## Adding things

- **A new task kind** → an executor that `handles` it (`src/executors/`), a verification method,
  and an eval.
- **A new harness** → `src/harnesses/<name>/{logic,plan}.mjs` + an executor + register it in the
  CLI `HARNESSES` map. Each phase leaves a schema-checked artifact.
- **A new model provider** → an adapter in `src/llm/` implementing `available()` + `chat()`.

## Reporting issues

Please include: what you ran, what you expected, what happened, and (if relevant) the failing eval
or the contents of the run's `evidence.json`.

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
