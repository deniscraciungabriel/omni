// Task graph engine: typed tasks, dependency-aware eligibility, atomic pull-based claiming,
// and an explicit lifecycle. A task is the unit of routed, verified, evidenced work.
import { run, get, all, J, P } from "../db.mjs";
import { id } from "../ids.mjs";
import { emit, metric } from "../events.mjs";
import { nowIso, POLICY } from "../config.mjs";

const JSON_FIELDS = ["skill_tags", "depends_on", "verification_plan", "evidence", "artifacts", "spec", "result"];

function hydrate(row) {
  if (!row) return null;
  const t = { ...row };
  for (const f of JSON_FIELDS) t[f] = P(row[f], f === "evidence" || f === "artifacts" ? [] : null);
  return t;
}

export function createTask(fields = {}) {
  const t = {
    id: id("task"),
    goal_id: fields.goal_id || null,
    project_id: fields.project_id || null,
    title: fields.title || "Untitled task",
    description: fields.description || "",
    kind: fields.kind || "command",
    skill_tags: fields.skill_tags || [],
    status: fields.status || "pending",
    depends_on: fields.depends_on || [],
    priority: fields.priority ?? 5,
    risk_level: fields.risk_level || "low",
    budget_limit: fields.budget_limit ?? 0,
    max_attempts: fields.max_attempts ?? POLICY.maxAttempts,
    owner: fields.owner || null,
    reviewer: fields.reviewer || null,
    verification_plan: fields.verification_plan || null,
    spec: fields.spec || null,
    depth: fields.depth ?? 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  run(
    `INSERT INTO tasks
     (id,goal_id,project_id,title,description,kind,skill_tags,status,depends_on,priority,
      risk_level,budget_limit,max_attempts,owner,reviewer,verification_plan,spec,depth,
      created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    t.id, t.goal_id, t.project_id, t.title, t.description, t.kind, J(t.skill_tags),
    t.status, J(t.depends_on), t.priority, t.risk_level, t.budget_limit, t.max_attempts,
    t.owner, t.reviewer, J(t.verification_plan), J(t.spec), t.depth, t.created_at, t.updated_at
  );
  emit("task.created", { task_id: t.id, goal_id: t.goal_id, project_id: t.project_id, message: t.title });
  return t.id;
}

export function getTask(taskId) {
  return hydrate(get(`SELECT * FROM tasks WHERE id=?`, taskId));
}

export function listTasks(filter = {}) {
  const where = [];
  const params = [];
  if (filter.status) { where.push("status=?"); params.push(filter.status); }
  if (filter.goal_id) { where.push("goal_id=?"); params.push(filter.goal_id); }
  if (filter.project_id) { where.push("project_id=?"); params.push(filter.project_id); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY priority ASC, created_at ASC`;
  return all(sql, ...params).map(hydrate);
}

export function updateTask(taskId, patch = {}) {
  const cur = getTask(taskId);
  if (!cur) throw new Error(`task not found: ${taskId}`);
  const cols = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k}=?`);
    params.push(JSON_FIELDS.includes(k) ? J(v) : v);
  }
  cols.push("updated_at=?");
  params.push(nowIso());
  params.push(taskId);
  run(`UPDATE tasks SET ${cols.join(", ")} WHERE id=?`, ...params);
  return getTask(taskId);
}

// A task is eligible when pending, approved (if required), and all deps are done.
function depsSatisfied(task) {
  const deps = task.depends_on || [];
  if (deps.length === 0) return true;
  for (const d of deps) {
    const dep = get(`SELECT status FROM tasks WHERE id=?`, d);
    if (!dep || dep.status !== "done") return false;
  }
  return true;
}

// Atomically claim the highest-priority eligible task. Returns hydrated task or null.
// Lock is leased; expired locks are reclaimable (survives worker crashes).
export function claimNext(worker, opts = {}) {
  const leaseFloor = new Date(Date.now() - POLICY.lockLeaseMs).toISOString();
  const candidates = all(
    `SELECT * FROM tasks
     WHERE status IN ('pending','claimed')
       AND (lock_owner IS NULL OR lock_at < ?)
     ORDER BY priority ASC, created_at ASC`,
    leaseFloor
  ).map(hydrate);

  for (const t of candidates) {
    if (!depsSatisfied(t)) continue;
    if (opts.skills && opts.skills.length && (t.skill_tags || []).length) {
      const match = t.skill_tags.some((s) => opts.skills.includes(s));
      if (!match) continue;
    }
    // Atomic compare-and-set: only one worker wins.
    const res = run(
      `UPDATE tasks SET status='claimed', lock_owner=?, lock_at=?, updated_at=?
       WHERE id=? AND status IN ('pending','claimed')
         AND (lock_owner IS NULL OR lock_at < ?)`,
      worker, nowIso(), nowIso(), t.id, leaseFloor
    );
    if (res.changes === 1) {
      emit("task.claimed", { task_id: t.id, goal_id: t.goal_id, project_id: t.project_id, message: `${worker} claimed ${t.title}` });
      return getTask(t.id);
    }
  }
  return null;
}

export function releaseLock(taskId) {
  run(`UPDATE tasks SET lock_owner=NULL, lock_at=NULL, updated_at=? WHERE id=?`, nowIso(), taskId);
}

export function markStatus(taskId, status, extra = {}) {
  updateTask(taskId, { status, ...extra });
  const t = getTask(taskId);
  emit(`task.${status}`, {
    task_id: taskId, goal_id: t.goal_id, project_id: t.project_id,
    level: status === "failed" ? "error" : status === "done" ? "success" : "info",
    message: `${t.title} -> ${status}`,
  });
  metric("task_status", 1, { status });
  return t;
}

// How many tasks remain that could still run for a goal (or globally).
export function pendingCount(goalId = null) {
  const sql = goalId
    ? `SELECT COUNT(*) n FROM tasks WHERE goal_id=? AND status IN ('pending','claimed','running','verifying','needs_approval','blocked')`
    : `SELECT COUNT(*) n FROM tasks WHERE status IN ('pending','claimed','running','verifying','needs_approval','blocked')`;
  return (goalId ? get(sql, goalId) : get(sql)).n;
}

export { hydrate };
