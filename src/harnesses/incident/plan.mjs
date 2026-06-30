// Incident-recovery harness planner. Fixed 5-phase plan, schema-gated per phase.
import fs from "node:fs";
import path from "node:path";
import { createGoal } from "../../core/goals.mjs";
import { createTask } from "../../core/tasks.mjs";
import { ensureProject, workspaceDir } from "../../memory/memory.mjs";
import { id } from "../../ids.mjs";
import { emit } from "../../events.mjs";

const PHASES = [
  { key: "triage", title: "Phase 1 — triage & severity", verify: { method: "json_has", path: "01-triage.json", requireKeys: ["severity"] } },
  { key: "diagnose", title: "Phase 2 — diagnose root cause", deps: ["triage"], verify: { method: "json_has", path: "02-diagnose.json", requireKeys: ["topCause"] } },
  { key: "mitigate", title: "Phase 3 — mitigate (saga)", deps: ["diagnose"], verify: { method: "json_has", path: "03-mitigation.json", requireKeys: ["sagaStatus"] } },
  { key: "verify", title: "Phase 4 — verify recovery", deps: ["mitigate"], verify: { method: "json_has", path: "04-recovery.json", requireKeys: ["recovered"] } },
  { key: "postmortem", title: "Phase 5 — postmortem", deps: ["verify"], verify: { method: "file_contains", path: "report.md", substring: "Postmortem" } },
];

export function planIncident(incidentJsonText, opts = {}) {
  const projectId = opts.projectId || `proj_incident_${id("x").slice(-6)}`;
  ensureProject(projectId, { title: opts.title || "Incident", mode: "ops", description: "Incident/recovery harness run." });
  fs.writeFileSync(path.join(workspaceDir(projectId), "input.json"), incidentJsonText);

  const goalId = createGoal({ project_id: projectId, description: opts.title || "Incident response", mode: "ops", meta: { harness: "incident" } });
  const keyToId = {};
  const taskIds = [];
  for (const ph of PHASES) {
    const depends_on = (ph.deps || []).map((k) => keyToId[k]);
    const spec = { phase: ph.key };
    if (ph.key === "mitigate" && opts.failMitigation) spec.failMitigation = opts.failMitigation;
    const tid = createTask({
      goal_id: goalId, project_id: projectId, title: ph.title, kind: "incident",
      risk_level: ph.key === "mitigate" ? "medium" : "low", depends_on, verification_plan: ph.verify, spec,
      skill_tags: ["incident", "ops"],
    });
    keyToId[ph.key] = tid;
    taskIds.push(tid);
  }
  emit("plan.created", { goal_id: goalId, project_id: projectId, message: `incident harness: ${taskIds.length} phases` });
  return { goalId, projectId, taskIds };
}
