// Research/science harness planner. Fixed 6-phase plan, schema-gated per phase.
import fs from "node:fs";
import path from "node:path";
import { createGoal } from "../../core/goals.mjs";
import { createTask } from "../../core/tasks.mjs";
import { ensureProject, workspaceDir } from "../../memory/memory.mjs";
import { id } from "../../ids.mjs";
import { emit } from "../../events.mjs";

const PHASES = [
  { key: "hypothesis", title: "Phase 1 — question & hypothesis", verify: { method: "json_has", path: "01-hypothesis.json", requireKeys: ["method"] } },
  { key: "design", title: "Phase 2 — design & manifest (lineage)", deps: ["hypothesis"], verify: { method: "json_has", path: "02-design.json", requireKeys: ["manifest", "valid"] } },
  { key: "run", title: "Phase 3 — run seeded trials", deps: ["design"], verify: { method: "json_has", path: "03-run.json", requireKeys: ["results"] } },
  { key: "analyze", title: "Phase 4 — analyze + uncertainty", deps: ["run"], verify: { method: "json_has", path: "04-analysis.json", requireKeys: ["estimate_mean", "estimate_std"] } },
  { key: "reproduce", title: "Phase 5 — reproducibility check", deps: ["run"], verify: { method: "json_has", path: "05-repro.json", requireKeys: ["reproducible"] } },
  { key: "report", title: "Phase 6 — experiment report", deps: ["analyze", "reproduce"], verify: { method: "file_contains", path: "report.md", substring: "Reproducibility" } },
];

export function planResearch(specText, opts = {}) {
  const projectId = opts.projectId || `proj_research_${id("x").slice(-6)}`;
  ensureProject(projectId, { title: opts.title || "Experiment", mode: "research", description: "Research/science harness run." });
  fs.writeFileSync(path.join(workspaceDir(projectId), "input.json"), specText);

  const goalId = createGoal({ project_id: projectId, description: opts.title || "Experiment", mode: "research", meta: { harness: "research" } });
  const keyToId = {};
  const taskIds = [];
  for (const ph of PHASES) {
    const depends_on = (ph.deps || []).map((k) => keyToId[k]);
    const tid = createTask({
      goal_id: goalId, project_id: projectId, title: ph.title, kind: "research_exp",
      risk_level: "low", depends_on, verification_plan: ph.verify, spec: { phase: ph.key },
      skill_tags: ["research", "science"],
    });
    keyToId[ph.key] = tid;
    taskIds.push(tid);
  }
  emit("plan.created", { goal_id: goalId, project_id: projectId, message: `research harness: ${taskIds.length} phases` });
  return { goalId, projectId, taskIds };
}
