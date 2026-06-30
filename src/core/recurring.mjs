// Recurring operations engine. Portable + durable: jobs live in the DB with an interval; a
// `cron-tick` runs everything due. Wire `omni cron-tick` to host cron or the `loop` skill —
// the schedule survives restarts because it's persisted, not held in memory.
import fs from "node:fs";
import { run, get, all, J, P } from "../db.mjs";
import { id } from "../ids.mjs";
import { nowIso, PATHS } from "../config.mjs";
import { emit, metric } from "../events.mjs";

const NAMED = { hourly: 3600, daily: 86400, weekly: 604800 };

export function addRecurring({ name, action, every, args = {} }) {
  const interval_sec = typeof every === "number" ? every : NAMED[every] || 86400;
  const existing = get(`SELECT id FROM recurring WHERE name=?`, name);
  if (existing) {
    run(`UPDATE recurring SET action=?, interval_sec=?, args=?, enabled=1 WHERE id=?`,
      action, interval_sec, J(args), existing.id);
    return existing.id;
  }
  const rid = id("rec");
  run(`INSERT INTO recurring (id,name,action,interval_sec,args,enabled,runs,created_at)
       VALUES (?,?,?,?,?,1,0,?)`, rid, name, action, interval_sec, J(args), nowIso());
  emit("recurring.added", { message: `${name} every ${interval_sec}s -> ${action}` });
  return rid;
}

export function listRecurring() {
  return all(`SELECT * FROM recurring ORDER BY name`).map((r) => ({ ...r, args: P(r.args, {}) }));
}

export function dueJobs(nowMs = Date.now()) {
  return listRecurring().filter((j) => {
    if (!j.enabled) return false;
    if (!j.last_run) return true;
    return Date.parse(j.last_run) + j.interval_sec * 1000 <= nowMs;
  });
}

// Action registry. Each returns a small summary object.
async function runAction(action, args) {
  if (action === "eval") {
    const { runEvals } = await import("../../evals/run-evals.mjs");
    const r = await runEvals();
    return { action, pass_rate: r.pass_rate, passed: r.passed, total: r.total };
  }
  if (action === "scan") {
    const { proactiveScan } = await import("../improve/scan.mjs");
    return { action, created: proactiveScan().length };
  }
  if (action === "rollup") return { action, ...metricRollup() };
  return { action, skipped: true, reason: "unknown action" };
}

// Run all due jobs. Returns per-job results.
export async function cronTick(nowMs = Date.now()) {
  const due = dueJobs(nowMs);
  const results = [];
  for (const j of due) {
    let status = "ok", summary;
    try {
      summary = await runAction(j.action, j.args);
    } catch (e) {
      status = "error";
      summary = { error: e.message };
    }
    run(`UPDATE recurring SET last_run=?, last_status=?, runs=runs+1 WHERE id=?`, nowIso(), status, j.id);
    emit("recurring.ran", { level: status === "error" ? "error" : "success", message: `${j.name}: ${JSON.stringify(summary)}` });
    results.push({ name: j.name, status, summary });
  }
  return results;
}

// Daily metric rollup: snapshot the committed metrics to a durable file + DB metric.
export function metricRollup() {
  // late import avoids a load-time cycle (status imports queues/governance)
  const day = nowIso().slice(0, 10);
  const done = get(`SELECT COUNT(*) n FROM tasks WHERE status='done'`).n;
  const failed = get(`SELECT COUNT(*) n FROM tasks WHERE status='failed'`).n;
  const cost = get(`SELECT COALESCE(SUM(spent_cost),0) c FROM budgets WHERE scope='task'`).c;
  const lastEval = get(`SELECT pass_rate FROM eval_runs ORDER BY started_at DESC LIMIT 1`);
  const snap = { day, tasks_done: done, tasks_failed: failed, cost_total: Number(cost.toFixed(4)), eval_pass_rate: lastEval?.pass_rate ?? null, at: nowIso() };
  fs.mkdirSync(PATHS.state, { recursive: true });
  fs.writeFileSync(`${PATHS.state}/daily-rollup.json`, JSON.stringify(snap, null, 2));
  metric("daily_rollup", done, { day, cost: snap.cost_total });
  return snap;
}

// Seed the standard recurring ops (idempotent).
export function ensureRecurringDefaults() {
  addRecurring({ name: "daily-eval", action: "eval", every: "daily" });
  addRecurring({ name: "hourly-scan", action: "scan", every: "hourly" });
  addRecurring({ name: "daily-rollup", action: "rollup", every: "daily" });
}
