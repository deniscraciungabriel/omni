// Finance-reporting harness planner. Fixed 5-phase plan, schema-gated per phase.
import fs from "node:fs";
import path from "node:path";
import { createGoal } from "../../core/goals.mjs";
import { createTask } from "../../core/tasks.mjs";
import { ensureProject, workspaceDir } from "../../memory/memory.mjs";
import { id } from "../../ids.mjs";
import { emit } from "../../events.mjs";

const PHASES = [
  { key: "ingest", title: "Phase 1 — ingest financial data", verify: { method: "json_has", path: "01-ingest.json", requireKeys: ["records"] } },
  { key: "reconcile", title: "Phase 2 — reconcile vs ledger", deps: ["ingest"], verify: { method: "json_has", path: "02-reconcile.json", minItems: 1, requireKeys: ["status"] } },
  { key: "analyze", title: "Phase 3 — variance analysis", deps: ["ingest"], verify: { method: "json_has", path: "03-analysis.json", requireKeys: ["byAccount", "totals"] } },
  { key: "validate", title: "Phase 4 — validation gate", deps: ["reconcile", "analyze"], verify: { method: "json_has", path: "04-validation.json", requireKeys: ["risk", "valid"] } },
  { key: "report", title: "Phase 5 — board-style report", deps: ["validate"], verify: { method: "file_contains", path: "report.md", substring: "Variance" } },
];
// Optional 6th phase: gated LLM narrative behind a consistency gate (self-correcting loop).
const ENRICH_PHASE = { key: "enrich", title: "Phase 6 — LLM narrative (gated, consistency-gated)", deps: ["report"], verify: { method: "json_has", path: "06-enrich.json", requireKeys: ["status"] } };

export function planFinanceReport(csv, opts = {}) {
  const phases = opts.enrich ? [...PHASES, ENRICH_PHASE] : PHASES;
  const projectId = opts.projectId || `proj_finance_${id("x").slice(-6)}`;
  ensureProject(projectId, { title: opts.title || "Finance report", mode: "company", description: "Finance/reporting harness run." });
  fs.writeFileSync(path.join(workspaceDir(projectId), "input.csv"), csv);

  const goalId = createGoal({ project_id: projectId, description: opts.title || "Finance report", mode: "company", meta: { harness: "finance" } });
  const keyToId = {};
  const taskIds = [];
  for (const ph of phases) {
    const depends_on = (ph.deps || []).map((k) => keyToId[k]);
    const tid = createTask({
      goal_id: goalId, project_id: projectId, title: ph.title, kind: "finance",
      risk_level: "low", depends_on, verification_plan: ph.verify, spec: { phase: ph.key },
      skill_tags: ["finance", "reporting"],
    });
    keyToId[ph.key] = tid;
    taskIds.push(tid);
  }
  emit("plan.created", { goal_id: goalId, project_id: projectId, message: `finance harness: ${taskIds.length} phases` });
  return { goalId, projectId, taskIds };
}
