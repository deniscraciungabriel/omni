// Worker: pull-based execution fabric. For each claimed task it runs the closed loop:
//   approval gate -> execute -> verify -> evidence -> memory -> learn -> reconcile goal.
// Survives crashes (leased locks), records a visible session, never self-certifies.
import fs from "node:fs";
import path from "node:path";
import { getTask, claimNext, markStatus, updateTask, releaseLock } from "../core/tasks.mjs";
import { reconcileGoal } from "../core/goals.mjs";
import { pickExecutor } from "../executors/index.mjs";
import { verify } from "../verify/verify.mjs";
import { ensureApproval, recordSpend, recordTrustOutcome, checkDailyBudget } from "../core/governance.mjs";
import { ensureRepo, addWorktree, captureDiff, integrateWorktree, removeWorktree } from "../core/worktree.mjs";
import {
  ensureProject, workspaceDir, runDir, projectDir, writeTasksFile, recordFailure, writeStatus,
} from "../memory/memory.mjs";
import { listTasks } from "../core/tasks.mjs";
import { learnFromTask } from "../improve/improve.mjs";
import { syncQueues } from "../core/queues.mjs";
import { run, get, J } from "../db.mjs";
import { id } from "../ids.mjs";
import { emit, metric } from "../events.mjs";
import { nowIso } from "../config.mjs";

function openSession(s) {
  run(
    `INSERT INTO sessions (id,task_id,goal_id,project_id,worker,executor,status,log_path,started_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    s.id, s.task_id, s.goal_id, s.project_id, s.worker, s.executor, "running", s.log_path, nowIso()
  );
  emit("session.started", { session_id: s.id, task_id: s.task_id, goal_id: s.goal_id, project_id: s.project_id, message: `${s.executor} run` });
}
function closeSession(sessionId, status, result) {
  run(
    `UPDATE sessions SET status=?, exit_code=?, summary=?, cost=?, tokens=?, ended_at=? WHERE id=?`,
    status, result.exitCode ?? null, (result.summary || "").slice(0, 2000), result.cost || 0, result.tokens || 0, nowIso(), sessionId
  );
  emit("session." + status, { session_id: sessionId, level: status === "failed" ? "error" : "success", message: (result.summary || "").slice(0, 160) });
}

function buildEvidence(task, result, vres) {
  return [
    { kind: "execution", summary: result.summary, exitCode: result.exitCode ?? null, ts: nowIso() },
    ...(vres ? vres.evidence.map((e) => ({ kind: "verification", method: vres.method, ...e })) : []),
  ];
}

function writeEvidenceFile(ctx, payload) {
  fs.writeFileSync(path.join(ctx.runDir, "evidence.json"), JSON.stringify(payload, null, 2));
}

function refreshProjectMirror(projectId) {
  if (!projectId) return;
  const tasks = listTasks({ project_id: projectId });
  writeTasksFile(projectId, tasks);
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  writeStatus(projectId,
    `- tasks: ${tasks.length} (done ${done}, failed ${failed})\n` +
    `- open: ${tasks.filter((t) => ["pending", "claimed", "running", "verifying", "needs_approval", "blocked"].includes(t.status)).length}\n`);
}

export async function runTask(task, worker = "worker-1") {
  // 1. Approval gate BEFORE any side effect.
  const appr = ensureApproval(task);
  if (!appr.ok) {
    markStatus(task.id, appr.denied ? "cancelled" : "needs_approval", { escalation_reason: "awaiting approval" });
    releaseLock(task.id);
    refreshProjectMirror(task.project_id);
    return { taskId: task.id, status: appr.denied ? "cancelled" : "needs_approval" };
  }

  // 2. Set up project workspace + run dir + session.
  const sessionId = id("sess");
  const pid = task.project_id || "proj_default";
  ensureProject(pid, { title: pid });
  const ctx = {
    sessionId, worker,
    projectDir: projectDir(pid),
    workspaceDir: workspaceDir(pid),
    runDir: runDir(pid, sessionId),
  };
  fs.mkdirSync(ctx.runDir, { recursive: true });

  const exec = pickExecutor(task);

  // Budget gate: spend-incurring engines pause (not fail) when the daily cost cap is hit.
  if (exec.name === "claude") {
    const b = checkDailyBudget();
    if (!b.ok) {
      markStatus(task.id, "needs_approval", { escalation_reason: `daily budget exceeded ($${b.spent.toFixed(2)}/$${b.limit})` });
      emit("budget.block", { task_id: task.id, level: "warn", message: `daily budget exceeded ($${b.spent.toFixed(2)}/$${b.limit})` });
      releaseLock(task.id);
      refreshProjectMirror(pid);
      return { taskId: task.id, status: "needs_approval", reason: "budget" };
    }
  }

  // Worktree isolation for coding tasks (graceful degradation if git is unavailable).
  if (task.spec && task.spec.worktree) {
    try {
      ensureRepo(ctx.workspaceDir);
      const wt = addWorktree(ctx.workspaceDir, task.id);
      ctx.cwd = wt.wtPath;
      ctx.worktree = { ...wt, repoDir: ctx.workspaceDir };
      emit("worktree.created", { task_id: task.id, message: wt.branch });
    } catch (e) {
      emit("worktree.skipped", { task_id: task.id, level: "warn", message: e.message });
    }
  }

  markStatus(task.id, "running", { executor: exec.name, attempts: (task.attempts || 0) + 1 });
  openSession({ id: sessionId, task_id: task.id, goal_id: task.goal_id, project_id: pid, worker, executor: exec.name, log_path: ctx.runDir });

  const startedAt = Date.now();
  let result;
  try {
    result = await exec.execute(task, ctx);
  } catch (e) {
    result = { ok: false, exitCode: 1, summary: `executor threw: ${e.message}` };
  }
  recordSpend(task, result.cost || 0, result.tokens || 0);

  // Capture the worktree diff as evidence (what the agent actually changed).
  if (ctx.worktree) {
    try {
      const d = captureDiff(ctx.worktree.wtPath);
      fs.writeFileSync(path.join(ctx.runDir, "diff.patch"), d.diff || "");
      result.artifacts = [...(result.artifacts || []), { path: `runs/${sessionId}/diff.patch`, kind: "diff", files: d.files, stat: d.stat }];
      result.summary += d.stat ? ` | changed: ${d.files.length} file(s)` : " | no file changes";
    } catch (e) {
      emit("worktree.diff_failed", { task_id: task.id, level: "warn", message: e.message });
    }
  }

  // Gated engine: leave pending, no cost, surface clearly.
  if (result.gated) {
    updateTask(task.id, { result });
    markStatus(task.id, "needs_approval", { escalation_reason: "execution engine gated (set OMNI_ALLOW_CLAUDE=1)" });
    closeSession(sessionId, "failed", result);
    releaseLock(task.id);
    refreshProjectMirror(pid);
    return { taskId: task.id, status: "gated" };
  }

  if (!result.ok) return finishFailure(task, worker, sessionId, ctx, result, startedAt, null);

  // 3. Verify (independent).
  markStatus(task.id, "verifying", {});
  let vres;
  try {
    vres = await verify(task, ctx);
  } catch (e) {
    vres = { passed: false, method: "error", evidence: [{ kind: "error", value: e.message }] };
  }
  const evidence = buildEvidence(task, result, vres);
  writeEvidenceFile(ctx, { task: { id: task.id, title: task.title }, result, verification: vres, evidence });

  if (vres.passed === true) {
    const ms = Date.now() - startedAt;
    // Integrate isolated work back into the sandbox repo's main tree.
    if (ctx.worktree) {
      try {
        integrateWorktree(ctx.worktree.repoDir, ctx.worktree.branch, ctx.worktree.wtPath, `omni: ${task.title}`);
        emit("worktree.integrated", { task_id: task.id, level: "success", message: ctx.worktree.branch });
      } catch (e) {
        emit("worktree.integrate_failed", { task_id: task.id, level: "warn", message: e.message });
      }
    }
    updateTask(task.id, { evidence, artifacts: result.artifacts || [], result });
    markStatus(task.id, "done", {});
    closeSession(sessionId, "done", result);
    releaseLock(task.id);
    metric("task_time_ms", ms, { kind: task.kind });
    recordTrustOutcome(task.kind, true);
    learnFromTask(task, { success: true, result, vres });
    reconcileGoal(task.goal_id);
    refreshProjectMirror(pid);
    syncQueues();
    return { taskId: task.id, status: "done", ms, evidence };
  }

  if (vres.passed === null) {
    updateTask(task.id, { evidence, artifacts: result.artifacts || [], result });
    markStatus(task.id, "needs_approval", { escalation_reason: "verification needs human review" });
    closeSession(sessionId, "done", result);
    releaseLock(task.id);
    refreshProjectMirror(pid);
    return { taskId: task.id, status: "needs_review", evidence };
  }

  // verification failed -> failure path
  result.summary = `${result.summary} | VERIFICATION FAILED (${vres.method})`;
  return finishFailure(task, worker, sessionId, ctx, result, startedAt, vres);
}

function finishFailure(task, worker, sessionId, ctx, result, startedAt, vres) {
  // Discard isolated work on failure; a retry gets a fresh worktree.
  if (ctx.worktree) { try { removeWorktree(ctx.worktree.repoDir, ctx.worktree.wtPath); } catch {} }
  const evidence = buildEvidence(task, result, vres);
  writeEvidenceFile(ctx, { task: { id: task.id, title: task.title }, result, verification: vres, evidence, failed: true });
  updateTask(task.id, { evidence, result });
  closeSession(sessionId, "failed", result);

  const fresh = getTask(task.id);
  const attempts = fresh.attempts || 0;
  if (attempts < (fresh.max_attempts || 2)) {
    // Retry once (with a recorded variation note), then escalate.
    markStatus(task.id, "pending", { escalation_reason: `retry ${attempts}/${fresh.max_attempts}: ${result.summary.slice(0, 120)}` });
    releaseLock(task.id);
    emit("task.retry", { task_id: task.id, level: "warn", message: `retry ${attempts}/${fresh.max_attempts}` });
    refreshProjectMirror(task.project_id);
    return { taskId: task.id, status: "retry" };
  }

  // Terminal failure: record, learn, reconcile.
  markStatus(task.id, "failed", { escalation_reason: result.summary.slice(0, 200) });
  releaseLock(task.id);
  if (task.project_id) recordFailure(task.project_id, task.title, `${result.summary}\n\nEvidence: runs/${ctx.sessionId}/evidence.json`);
  recordTrustOutcome(task.kind, false);
  learnFromTask(task, { success: false, result, vres });
  reconcileGoal(task.goal_id);
  refreshProjectMirror(task.project_id);
  syncQueues();
  return { taskId: task.id, status: "failed" };
}

// Claim + run a single eligible task.
export async function tick(worker = "worker-1", opts = {}) {
  const task = claimNext(worker, opts);
  if (!task) return { idle: true };
  return await runTask(task, worker);
}

// Drain the queue: keep ticking until no eligible task remains (or a guard trips).
export async function runLoop(worker = "worker-1", opts = {}) {
  const results = [];
  const maxTicks = opts.maxTicks || 500;
  for (let i = 0; i < maxTicks; i++) {
    const r = await tick(worker, opts);
    if (r.idle) break;
    results.push(r);
  }
  syncQueues();
  return results;
}
