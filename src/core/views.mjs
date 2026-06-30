// Altitude control. The same underlying state powers every zoom level:
//   session -> task -> goal -> project -> portfolio.
// Each view is a read-only assembly for humans (dashboard) and agents (resume/handoff).
import fs from "node:fs";
import path from "node:path";
import { all, get, P } from "../db.mjs";
import { getTask, listTasks } from "./tasks.mjs";
import { getGoal } from "./goals.mjs";
import { projectDir } from "../memory/memory.mjs";

function readIf(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

export function sessionView(sessionId) {
  const s = get(`SELECT * FROM sessions WHERE id=?`, sessionId);
  if (!s) return null;
  const events = all(`SELECT ts,type,level,message FROM events WHERE session_id=? ORDER BY ts ASC`, sessionId);
  const evidence = s.log_path ? P(readIf(path.join(s.log_path, "evidence.json")), null) : null;
  const diff = s.log_path ? readIf(path.join(s.log_path, "diff.patch")) : null;
  return { session: s, events, evidence, diff: diff ? diff.slice(0, 8000) : null };
}

export function taskView(taskId) {
  const task = getTask(taskId);
  if (!task) return null;
  const sessions = all(`SELECT id,executor,status,cost,tokens,started_at,ended_at,summary FROM sessions WHERE task_id=? ORDER BY started_at ASC`, taskId);
  const approval = get(`SELECT * FROM approvals WHERE task_id=? ORDER BY created_at DESC LIMIT 1`, taskId);
  return {
    task: {
      id: task.id, title: task.title, status: task.status, kind: task.kind, risk_level: task.risk_level,
      goal_id: task.goal_id, project_id: task.project_id, depends_on: task.depends_on,
      attempts: task.attempts, executor: task.executor, escalation_reason: task.escalation_reason,
      verification_plan: task.verification_plan, evidence: task.evidence, artifacts: task.artifacts,
    },
    sessions,
    approval: approval ? { ...approval, detail: P(approval.detail, null) } : null,
  };
}

export function goalView(goalId) {
  const goal = getGoal(goalId);
  if (!goal) return null;
  const tasks = listTasks({ goal_id: goalId });
  const cost = get(`SELECT COALESCE(SUM(spent_cost),0) c FROM budgets WHERE scope='goal' AND scope_id=?`, goalId).c;
  const done = tasks.filter((t) => t.status === "done").length;
  return {
    goal,
    progress: { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0 },
    cost: Number(cost.toFixed(4)),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, kind: t.kind, risk_level: t.risk_level, depends_on: t.depends_on })),
  };
}

export function projectView(projectId) {
  const dir = projectDir(projectId);
  const tasks = listTasks({ project_id: projectId });
  const goals = all(`SELECT id,description,status FROM goals WHERE project_id=?`, projectId);
  const cost = get(`SELECT COALESCE(SUM(spent_cost),0) c FROM budgets WHERE scope='task' AND scope_id IN (SELECT id FROM tasks WHERE project_id=?)`, projectId).c;
  const sessions = all(`SELECT id,executor,status,cost,started_at FROM sessions WHERE project_id=? ORDER BY started_at DESC LIMIT 8`, projectId);
  const knowledgeCount = get(`SELECT COUNT(*) n FROM knowledge WHERE project_id=?`, projectId).n;
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  return {
    project_id: projectId,
    files: {
      status: readIf(path.join(dir, "status.md")),
      plan: readIf(path.join(dir, "plan.md")),
      handoff: readIf(path.join(dir, "handoff.md")),
      knowledge: readIf(path.join(dir, "knowledge.md")),
    },
    goals,
    tasksByStatus: byStatus,
    knowledgeCount,
    cost: Number(cost.toFixed(4)),
    recentSessions: sessions,
  };
}

// Cross-project synthesis: the portfolio altitude.
export function portfolioView() {
  const projects = all(`SELECT DISTINCT project_id FROM tasks WHERE project_id IS NOT NULL`).map((r) => r.project_id);
  const rows = projects.map((pid) => {
    const tasks = listTasks({ project_id: pid });
    const done = tasks.filter((t) => t.status === "done").length;
    const blocked = tasks.filter((t) => ["blocked", "needs_approval"].includes(t.status)).length;
    const cost = get(`SELECT COALESCE(SUM(spent_cost),0) c FROM budgets WHERE scope='task' AND scope_id IN (SELECT id FROM tasks WHERE project_id=?)`, pid).c;
    return { project_id: pid, tasks: tasks.length, done, blocked, cost: Number(cost.toFixed(4)) };
  });
  return {
    projects: rows.sort((a, b) => b.blocked - a.blocked || b.tasks - a.tasks),
    totals: {
      projects: rows.length,
      open_approvals: get(`SELECT COUNT(*) n FROM approvals WHERE status='pending'`).n,
      total_cost: Number(rows.reduce((s, r) => s + r.cost, 0).toFixed(4)),
      blocked: rows.reduce((s, r) => s + r.blocked, 0),
    },
  };
}
