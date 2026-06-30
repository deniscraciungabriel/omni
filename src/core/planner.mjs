// Planner: goal -> task graph. Two modes:
//   1. Playbook (deterministic, fixed plan): standardized, repeatable workflows.
//   2. Freeform (dynamic plan): open-ended goal -> a single gated LLM planning/execution task.
// Fixed plans for standardized work; dynamic plans for ambiguous work (per doctrine).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PATHS, POLICY } from "../config.mjs";
import { createGoal } from "./goals.mjs";
import { createTask } from "./tasks.mjs";
import { ensureProject } from "../memory/memory.mjs";
import { id } from "../ids.mjs";
import { emit } from "../events.mjs";
import { log } from "../log.mjs";

export function loadPlaybook(name) {
  const file = path.join(PATHS.playbooks, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`playbook not found: ${name} (${file})`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function listPlaybooks() {
  if (!fs.existsSync(PATHS.playbooks)) return [];
  return fs
    .readdirSync(PATHS.playbooks)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

// Recursively substitute {{param}} placeholders in a playbook with provided params.
function substitute(obj, params) {
  if (typeof obj === "string") return obj.replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] != null ? params[k] : `{{${k}}}`));
  if (Array.isArray(obj)) return obj.map((x) => substitute(x, params));
  if (obj && typeof obj === "object") {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[k] = substitute(v, params);
    return o;
  }
  return obj;
}

// Plan from a playbook (optionally parameterized via opts.params). Returns { goalId, projectId, taskIds }.
export function planFromPlaybook(name, opts = {}) {
  let pb = loadPlaybook(name);
  if (pb.params) {
    const params = opts.params || {};
    const missing = pb.params.filter((p) => params[p] == null);
    if (missing.length) throw new Error(`playbook ${name} needs params: ${missing.join(", ")}`);
    pb = substitute(pb, params);
  }
  const projectId = opts.projectId || `proj_${name}_${id("x").slice(-6)}`;
  ensureProject(projectId, { title: pb.title || name, mode: pb.mode || "general", description: pb.description || "" });

  const goalId = createGoal({
    project_id: projectId,
    description: pb.title || `Run playbook ${name}`,
    mode: pb.mode || "general",
    meta: { playbook: name },
  });

  const keyToId = {};
  const taskIds = [];
  for (const spec of pb.tasks) {
    const depends_on = (spec.depends_on || []).map((k) => {
      if (!keyToId[k]) throw new Error(`playbook ${name}: task '${spec.key}' depends on unknown key '${k}'`);
      return keyToId[k];
    });
    const taskId = createTask({
      goal_id: goalId,
      project_id: projectId,
      title: spec.title,
      description: spec.description || "",
      kind: spec.kind || "command",
      skill_tags: spec.skill_tags || [],
      risk_level: spec.risk_level || "low",
      depends_on,
      priority: spec.priority ?? 5,
      verification_plan: spec.verify || { method: "none" },
      spec: spec.spec || {},
    });
    keyToId[spec.key] = taskId;
    taskIds.push(taskId);
  }
  emit("plan.created", { goal_id: goalId, project_id: projectId, message: `${taskIds.length} tasks from playbook ${name}` });
  log.ok(`Planned ${taskIds.length} tasks for goal ${goalId} (project ${projectId})`);
  return { goalId, projectId, taskIds };
}

// Heuristic risk classification for freeform goals (deny-first on destructive verbs).
function classifyRisk(text) {
  const t = text.toLowerCase();
  if (/\b(delete|drop|rm -rf|deploy|prod|production|send email|wire|payment|refund|migrate)\b/.test(t)) return "high";
  if (/\b(write|create|install|push|commit|modify|update)\b/.test(t)) return "medium";
  return "low";
}

// Extract the first balanced JSON object from arbitrary model text (handles ``` fences).
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, "```").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}" && --depth === 0) {
      try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const PLANNER_SCHEMA_PROMPT = `You are the omni planner. Decompose the GOAL into a minimal task graph.
Output ONLY a JSON object, no prose, matching exactly:
{
  "project_title": "short title",
  "mode": "software|research|ops|general",
  "tasks": [
    {
      "key": "unique_snake_key",
      "title": "imperative task title",
      "kind": "llm | command | memory",
      "risk_level": "low|medium|high",
      "depends_on": ["other_key"],
      "worktree": true,
      "instructions": "for kind=llm: precise instructions for the coding agent, incl. exact filenames",
      "run": "for kind=command: a shell command",
      "knowledge": { "key": "k", "value": "v" },
      "verify": { "method": "node_test|command|file_exists|knowledge_present|none", "cmd": "node --test --no-warnings", "expectExit": 0, "paths": ["f.mjs"], "key": "k" }
    }
  ]
}
Rules: prefer kind=llm with worktree=true for code; verify code with method "node_test" (which
fails on zero tests). Keep it to 1-4 tasks. Every task MUST have a verify. Use only listed methods.`;

// LLM planner (GATED). Calls claude to produce a typed task graph. Falls back to a single safe
// task when LLM is disabled or output is invalid — so it never spends or stalls silently.
export function planFreeformLLM(description, opts = {}) {
  if (!POLICY.allowClaude) {
    const r = planFreeform(description, opts);
    return { ...r, fallback: "llm_disabled" };
  }
  const res = spawnSync(POLICY.claudeBin, ["-p", "--output-format", "json"], {
    input: `${PLANNER_SCHEMA_PROMPT}\n\nGOAL: ${description}`,
    encoding: "utf8", timeout: POLICY.taskTimeoutMs, maxBuffer: 32 * 1024 * 1024,
  });
  let outer = null;
  try { outer = JSON.parse(res.stdout); } catch { /* */ }
  const planObj = extractJson(outer?.result || res.stdout || "");
  if (!planObj || !Array.isArray(planObj.tasks) || !planObj.tasks.length) {
    const r = planFreeform(description, opts);
    return { ...r, fallback: "invalid_plan", planCost: outer?.total_cost_usd || 0 };
  }

  const projectId = opts.projectId || `proj_${id("x").slice(-8)}`;
  ensureProject(projectId, { title: planObj.project_title || description.slice(0, 60), mode: planObj.mode || "general", description });
  const goalId = createGoal({ project_id: projectId, description, mode: planObj.mode || "general", meta: { planner: "llm", planCost: outer?.total_cost_usd || 0 } });

  const keyToId = {};
  const taskIds = [];
  for (const t of planObj.tasks.slice(0, 5)) {
    const depends_on = (t.depends_on || []).map((k) => keyToId[k]).filter(Boolean);
    const spec = {};
    if (t.kind === "llm") { spec.prompt = t.instructions || t.title; spec.worktree = t.worktree !== false; spec.executor = "claude"; }
    if (t.kind === "command" && t.run) spec.run = { cmd: t.run };
    if (t.knowledge) spec.knowledge = t.knowledge;
    const taskId = createTask({
      goal_id: goalId, project_id: projectId, title: t.title || "task",
      description: t.instructions || "", kind: t.kind || "llm",
      risk_level: t.risk_level || "low", depends_on,
      verification_plan: t.verify || { method: "none" }, spec,
      skill_tags: t.kind === "llm" ? ["coding"] : [],
    });
    keyToId[t.key] = taskId;
    taskIds.push(taskId);
  }
  emit("plan.created", { goal_id: goalId, project_id: projectId, message: `LLM plan: ${taskIds.length} tasks ($${(outer?.total_cost_usd || 0).toFixed(4)})` });
  log.ok(`LLM planned ${taskIds.length} tasks for goal ${goalId} (project ${projectId})`);
  return { goalId, projectId, taskIds, planCost: outer?.total_cost_usd || 0 };
}

// Plan a freeform goal: one LLM task (gated). The LLM executor may itself decompose later.
export function planFreeform(description, opts = {}) {
  const projectId = opts.projectId || `proj_${id("x").slice(-8)}`;
  ensureProject(projectId, { title: description.slice(0, 60), mode: opts.mode || "general", description });
  const goalId = createGoal({ project_id: projectId, description, mode: opts.mode || "general" });
  const risk = opts.risk || classifyRisk(description);
  const taskId = createTask({
    goal_id: goalId,
    project_id: projectId,
    title: description.slice(0, 80),
    description,
    kind: "llm",
    risk_level: risk,
    verification_plan: opts.verify || { method: "manual", note: "Review LLM output + artifacts" },
    spec: { prompt: description, profile: opts.profile || "executor" },
  });
  emit("plan.created", { goal_id: goalId, project_id: projectId, message: `freeform goal -> 1 llm task (risk ${risk})` });
  return { goalId, projectId, taskIds: [taskId] };
}
