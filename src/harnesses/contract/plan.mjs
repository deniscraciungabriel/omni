// Contract-review harness planner. A FIXED plan (standardized, repeatable, reliability-critical):
// 5 sequential phases, each gated by a schema check on its artifact. State flows via files in
// the project workspace so the run is resumable and inspectable.
import fs from "node:fs";
import path from "node:path";
import { createGoal } from "../../core/goals.mjs";
import { createTask } from "../../core/tasks.mjs";
import { ensureProject, workspaceDir } from "../../memory/memory.mjs";
import { id } from "../../ids.mjs";
import { emit } from "../../events.mjs";

const PHASES = [
  { key: "classify", title: "Phase 1 — classify document", verify: { method: "json_has", path: "01-classify.json", requireKeys: ["docType"] } },
  { key: "extract", title: "Phase 2 — extract & categorize clauses", deps: ["classify"], verify: { method: "json_has", path: "02-clauses.json", minItems: 1, requireKeys: ["category"] } },
  { key: "review", title: "Phase 3 — risk review vs playbook", deps: ["extract"], verify: { method: "json_has", path: "03-findings.json", minItems: 1, requireKeys: ["rule", "status"] } },
  { key: "validate", title: "Phase 4 — validation gate", deps: ["review"], verify: { method: "json_has", path: "04-validation.json", requireKeys: ["riskScore", "valid"] } },
  { key: "synthesize", title: "Phase 5 — templated report", deps: ["validate"], verify: { method: "file_contains", path: "report.md", substring: "Risk score" } },
];

export function planContractReview(text, opts = {}) {
  const projectId = opts.projectId || `proj_contract_${id("x").slice(-6)}`;
  ensureProject(projectId, { title: opts.title || "Contract review", mode: "delivery", description: "Specialized contract-review harness run." });
  fs.writeFileSync(path.join(workspaceDir(projectId), "input.txt"), text);

  const goalId = createGoal({ project_id: projectId, description: opts.title || "Contract review", mode: "delivery", meta: { harness: "contract" } });
  const keyToId = {};
  const taskIds = [];
  for (const ph of PHASES) {
    const depends_on = (ph.deps || []).map((k) => keyToId[k]);
    const tid = createTask({
      goal_id: goalId, project_id: projectId, title: ph.title, kind: "contract",
      risk_level: "low", depends_on, verification_plan: ph.verify, spec: { phase: ph.key },
      skill_tags: ["contract", "legal"],
    });
    keyToId[ph.key] = tid;
    taskIds.push(tid);
  }
  emit("plan.created", { goal_id: goalId, project_id: projectId, message: `contract harness: ${taskIds.length} phases` });
  return { goalId, projectId, taskIds };
}
