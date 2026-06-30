// Governance: approvals gate risky work BEFORE dispatch; budgets cap spend; trust is earned
// per-domain from real outcomes. Deny-first for destructive actions.
import { run, get, all, J, P } from "../db.mjs";
import { id } from "../ids.mjs";
import { emit } from "../events.mjs";
import { nowIso, POLICY, RISK_ORDER } from "../config.mjs";

export function needsApproval(task) {
  return POLICY.approvalRequiredRisk.includes(task.risk_level);
}

const IRREVERSIBLE = /\b(delete|drop|rm\s|deploy|prod|production|send|email|wire|payment|refund|publish|migrate|truncate)\b/i;

// What an action would touch + how reversible it is — the heart of approval UX.
export function computeBlastRadius(task) {
  const spec = task.spec || {};
  const text = `${task.title} ${task.description || ""} ${spec.run?.cmd || ""} ${spec.prompt || ""}`;
  const sideEffects = [];
  if (spec.run?.cmd) sideEffects.push(`shell: ${spec.run.cmd.slice(0, 80)}`);
  if (spec.writes?.length) sideEffects.push(`writes ${spec.writes.length} file(s)`);
  if (task.kind === "llm") sideEffects.push("LLM agent acts in the project workspace");
  if (IRREVERSIBLE.test(text)) sideEffects.push("⚠ contains hard-to-reverse verbs");
  return {
    what: task.title,
    why: task.escalation_reason || `risk=${task.risk_level} requires approval before side effects`,
    risk: task.risk_level,
    reversible: !IRREVERSIBLE.test(text),
    engine: task.kind === "llm" ? "claude" : task.kind === "command" ? "local" : task.kind,
    touches: { project_id: task.project_id, goal_id: task.goal_id },
    budget_limit: task.budget_limit || null,
    side_effects: sideEffects,
    if_approved: "task is dispatched and its verification_plan must pass before it is marked done",
    if_denied: "task is cancelled; no side effects occur",
  };
}

// Returns { ok:true } if cleared to run, or { ok:false, approvalId } if waiting on a human.
export function ensureApproval(task) {
  if (!needsApproval(task)) return { ok: true };
  const existing = get(
    `SELECT * FROM approvals WHERE task_id=? ORDER BY created_at DESC LIMIT 1`,
    task.id
  );
  if (existing && existing.status === "approved") return { ok: true };
  if (existing && existing.status === "denied") return { ok: false, denied: true, approvalId: existing.id };
  if (existing && existing.status === "pending") return { ok: false, approvalId: existing.id };
  const aid = id("appr");
  const blast = computeBlastRadius(task);
  run(
    `INSERT INTO approvals (id,task_id,goal_id,action,risk,status,reason,detail,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    aid, task.id, task.goal_id, task.title, task.risk_level, "pending",
    blast.why, J(blast), nowIso()
  );
  emit("approval.requested", {
    task_id: task.id, goal_id: task.goal_id, level: "warn",
    message: `Approval needed (${task.risk_level}): ${task.title}`, data: { approvalId: aid },
  });
  return { ok: false, approvalId: aid };
}

export function decideApproval(approvalId, decision, by = "human") {
  run(
    `UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=?`,
    decision, by, nowIso(), approvalId
  );
  const a = get(`SELECT * FROM approvals WHERE id=?`, approvalId);
  emit("approval." + decision, { task_id: a?.task_id, goal_id: a?.goal_id, message: `${decision} by ${by}` });
  // Unblock the task if approved.
  if (decision === "approved" && a?.task_id) {
    run(`UPDATE tasks SET status='pending', updated_at=? WHERE id=? AND status='needs_approval'`, nowIso(), a.task_id);
  }
  if (decision === "denied" && a?.task_id) {
    run(`UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?`, nowIso(), a.task_id);
  }
  return a;
}

export function pendingApprovals() {
  return all(`SELECT * FROM approvals WHERE status='pending' ORDER BY created_at ASC`)
    .map((a) => ({ ...a, detail: P(a.detail, null) }));
}

// --- budgets ---------------------------------------------------------------
function dayKey() {
  return nowIso().slice(0, 10);
}

export function addSpend(scope, scopeId, cost = 0, tokens = 0) {
  const existing = get(`SELECT * FROM budgets WHERE scope=? AND scope_id=?`, scope, scopeId);
  if (existing) {
    run(
      `UPDATE budgets SET spent_cost=spent_cost+?, spent_tokens=spent_tokens+?, updated_at=? WHERE scope=? AND scope_id=?`,
      cost, tokens, nowIso(), scope, scopeId
    );
  } else {
    run(
      `INSERT INTO budgets (scope,scope_id,limit_cost,spent_cost,limit_tokens,spent_tokens,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      scope, scopeId, scope === "day" ? POLICY.dailyCostLimit : 0, cost, 0, tokens, nowIso()
    );
  }
}

export function recordSpend(task, cost = 0, tokens = 0) {
  addSpend("day", dayKey(), cost, tokens);
  if (task.goal_id) addSpend("goal", task.goal_id, cost, tokens);
  addSpend("task", task.id, cost, tokens);
}

// Returns { ok, spent, limit } — soft daily guardrail for LLM spend.
export function checkDailyBudget() {
  const b = get(`SELECT * FROM budgets WHERE scope='day' AND scope_id=?`, dayKey());
  const spent = b?.spent_cost || 0;
  const limit = POLICY.dailyCostLimit;
  return { ok: spent < limit, spent, limit };
}

// --- trust -----------------------------------------------------------------
export function recordTrustOutcome(domain, success) {
  if (!domain) return;
  const t = get(`SELECT * FROM trust WHERE domain=?`, domain);
  if (!t) {
    run(`INSERT INTO trust (domain,level,successes,failures,updated_at) VALUES (?,?,?,?,?)`,
      domain, "supervised", success ? 1 : 0, success ? 0 : 1, nowIso());
  } else {
    run(`UPDATE trust SET successes=successes+?, failures=failures+?, updated_at=? WHERE domain=?`,
      success ? 1 : 0, success ? 0 : 1, nowIso(), domain);
  }
  promoteTrust(domain);
}

// Earn autonomy from outcomes: >=5 successes & <20% failure -> guided; >=15 & <10% -> autonomous.
function promoteTrust(domain) {
  const t = get(`SELECT * FROM trust WHERE domain=?`, domain);
  if (!t) return;
  const total = t.successes + t.failures;
  const failRate = total ? t.failures / total : 1;
  let level = t.level;
  if (t.successes >= 15 && failRate < 0.1) level = "autonomous";
  else if (t.successes >= 5 && failRate < 0.2) level = "guided";
  if (level !== t.level) {
    run(`UPDATE trust SET level=?, updated_at=? WHERE domain=?`, level, nowIso(), domain);
    emit("trust.promoted", { message: `${domain} -> ${level}`, data: { successes: t.successes, failures: t.failures } });
  }
}

export function listTrust() {
  return all(`SELECT * FROM trust ORDER BY successes DESC`);
}

export { RISK_ORDER };
