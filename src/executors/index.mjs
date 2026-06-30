// Executor registry + router. Maps a task to an execution engine by kind (with explicit
// override via task.spec.executor). Engines are swappable adapters — the wrapped runtime is
// a replaceable execution layer, not the source of truth.
import * as local from "./local.mjs";
import * as echo from "./echo.mjs";
import * as claude from "./claude.mjs";
import * as contract from "./contract.mjs";
import * as finance from "./finance.mjs";
import * as incident from "./incident.mjs";
import * as research from "./research.mjs";

const REGISTRY = [local, echo, claude, contract, finance, incident, research];

export function pickExecutor(task) {
  const override = task.spec && task.spec.executor;
  if (override) {
    const e = REGISTRY.find((x) => x.name === override);
    if (e) return e;
  }
  const e = REGISTRY.find((x) => x.handles.includes(task.kind));
  return e || local;
}

export function executorNames() {
  return REGISTRY.map((e) => e.name);
}
