// Human-readable status mirror + the metrics the contract commits to tracking.
import { all, get } from "./db.mjs";
import { allQueues } from "./core/queues.mjs";
import { recentEvents } from "./events.mjs";
import { listTrust, pendingApprovals, checkDailyBudget } from "./core/governance.mjs";

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function metricsSummary() {
  const tasksTotal = get(`SELECT COUNT(*) n FROM tasks`).n;
  const done = get(`SELECT COUNT(*) n FROM tasks WHERE status='done'`).n;
  const failed = get(`SELECT COUNT(*) n FROM tasks WHERE status='failed'`).n;
  const needsApproval = get(`SELECT COUNT(*) n FROM tasks WHERE status='needs_approval'`).n;
  const verified = get(`SELECT COUNT(*) n FROM tasks WHERE status='done' AND evidence IS NOT NULL AND evidence != '[]'`).n;
  const retries = get(`SELECT COUNT(*) n FROM events WHERE type='task.retry'`).n;
  const times = all(`SELECT value FROM metrics WHERE name='task_time_ms'`).map((r) => r.value);
  const lastEval = get(`SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT 1`);
  const day = checkDailyBudget();
  const costRow = get(`SELECT COALESCE(SUM(spent_cost),0) c FROM budgets WHERE scope='task'`);
  return {
    tasks_total: tasksTotal,
    tasks_completed: done,
    tasks_verified: verified,
    tasks_failed: failed,
    median_time_to_completion_ms: median(times),
    cost_total_usd: Number((costRow.c || 0).toFixed(4)),
    cost_per_successful_task_usd: done ? Number(((costRow.c || 0) / done).toFixed(4)) : 0,
    intervention_rate: tasksTotal ? Number((needsApproval / tasksTotal).toFixed(3)) : 0,
    retry_rate: tasksTotal ? Number((retries / tasksTotal).toFixed(3)) : 0,
    eval_pass_rate: lastEval ? lastEval.pass_rate : null,
    daily_budget: { spent: Number(day.spent.toFixed(4)), limit: day.limit, ok: day.ok },
  };
}

export function statusReport() {
  const goals = all(`SELECT * FROM goals ORDER BY created_at DESC LIMIT 10`);
  const byStatus = {};
  for (const r of all(`SELECT status, COUNT(*) n FROM tasks GROUP BY status`)) byStatus[r.status] = r.n;
  return {
    goals,
    tasksByStatus: byStatus,
    queues: allQueues(),
    approvals: pendingApprovals(),
    trust: listTrust(),
    metrics: metricsSummary(),
    events: recentEvents(12),
  };
}

export function printStatus() {
  const r = statusReport();
  const out = [];
  out.push("\n\x1b[1mOMNI — status\x1b[0m");
  out.push("─".repeat(56));
  out.push("Tasks by status: " + (Object.entries(r.tasksByStatus).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"));
  out.push("Goals: " + r.goals.length + "  ·  Pending approvals: " + r.approvals.length);
  out.push("");
  out.push("Momentum queues:");
  for (const q of ["now", "next", "blocked", "improve", "recurring"]) {
    const items = r.queues[q] || [];
    out.push(`  ${q.padEnd(9)} ${items.length ? items.slice(0, 4).map((i) => i.title).join(" | ") : "(empty)"}`);
  }
  out.push("");
  const m = r.metrics;
  out.push("Metrics:");
  out.push(`  completed=${m.tasks_completed}/${m.tasks_total}  verified=${m.tasks_verified}  failed=${m.tasks_failed}`);
  out.push(`  median_time=${m.median_time_to_completion_ms}ms  cost=$${m.cost_total_usd}  cost/success=$${m.cost_per_successful_task_usd}`);
  out.push(`  intervention_rate=${m.intervention_rate}  retry_rate=${m.retry_rate}  eval_pass_rate=${m.eval_pass_rate ?? "n/a"}`);
  out.push(`  daily_budget=$${m.daily_budget.spent}/$${m.daily_budget.limit} ${m.daily_budget.ok ? "ok" : "OVER"}`);
  out.push("");
  out.push("Recent events:");
  for (const e of r.events.slice(0, 8)) out.push(`  ${e.ts.slice(11, 19)} ${e.type.padEnd(18)} ${e.message || ""}`);
  out.push("");
  return out.join("\n");
}
