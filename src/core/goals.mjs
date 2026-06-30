// Goals: top-level intents that decompose into task graphs. A goal is bound to a project
// (its durable file pack) so work survives runtime changes.
import { run, get, all, J, P } from "../db.mjs";
import { id } from "../ids.mjs";
import { emit } from "../events.mjs";
import { nowIso } from "../config.mjs";
import { pendingCount } from "./tasks.mjs";

export function createGoal(fields = {}) {
  const g = {
    id: id("goal"),
    project_id: fields.project_id || null,
    description: fields.description || "Untitled goal",
    mode: fields.mode || "general",
    status: fields.status || "open",
    priority: fields.priority ?? 5,
    meta: fields.meta || {},
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  run(
    `INSERT INTO goals (id,project_id,description,mode,status,priority,meta,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    g.id, g.project_id, g.description, g.mode, g.status, g.priority, J(g.meta), g.created_at, g.updated_at
  );
  emit("goal.created", { goal_id: g.id, project_id: g.project_id, message: g.description });
  return g.id;
}

export function getGoal(goalId) {
  const row = get(`SELECT * FROM goals WHERE id=?`, goalId);
  if (!row) return null;
  return { ...row, meta: P(row.meta, {}) };
}

export function listGoals(filter = {}) {
  const where = [];
  const params = [];
  if (filter.status) { where.push("status=?"); params.push(filter.status); }
  if (filter.project_id) { where.push("project_id=?"); params.push(filter.project_id); }
  const sql = `SELECT * FROM goals ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY priority ASC, created_at DESC`;
  return all(sql, ...params).map((r) => ({ ...r, meta: P(r.meta, {}) }));
}

export function setGoalStatus(goalId, status) {
  run(`UPDATE goals SET status=?, updated_at=? WHERE id=?`, status, nowIso(), goalId);
  emit("goal." + status, { goal_id: goalId, message: `goal -> ${status}` });
}

// Recompute a goal's status from its tasks (called after each task completes).
export function reconcileGoal(goalId) {
  if (!goalId) return;
  const remaining = pendingCount(goalId);
  const failed = get(`SELECT COUNT(*) n FROM tasks WHERE goal_id=? AND status='failed'`, goalId).n;
  const total = get(`SELECT COUNT(*) n FROM tasks WHERE goal_id=?`, goalId).n;
  if (total === 0) return;
  if (remaining === 0) {
    setGoalStatus(goalId, failed > 0 ? "blocked" : "done");
  } else {
    const cur = getGoal(goalId);
    if (cur && cur.status === "open") setGoalStatus(goalId, "active");
  }
}
