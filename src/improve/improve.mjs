// Self-improvement. Two modes:
//   1. Inline learning after every task (record what worked / convert failures to ratchets).
//   2. Background one-change loop (pick ONE hypothesis, change, eval, keep-or-revert).
// Every meaningful success should leave a reusable ratchet; every repeated failure a guardrail.
import { get } from "../db.mjs";
import { addQueueItem } from "../core/queues.mjs";
import { appendKnowledge } from "../memory/memory.mjs";
import { emit, metric } from "../events.mjs";

// Classify a failure into a leverage category (drives the right repair).
export function classifyGap(task, result, vres) {
  const txt = `${result?.summary || ""} ${vres?.method || ""}`.toLowerCase();
  if (vres && vres.passed === false) return "bad_verification_or_execution";
  if (/timeout|timed out|124/.test(txt)) return "external_dependency_or_timeout";
  if (/not found|enoent|missing/.test(txt)) return "missing_tool_or_artifact";
  if (result?.gated) return "missing_permission";
  return "execution_failure";
}

// Called after every terminal task outcome. Leaves a ratchet behind.
export function learnFromTask(task, { success, result, vres }) {
  if (success) {
    metric("task_success", 1, { kind: task.kind });
    // First success of a kind/playbook becomes procedural memory (a reusable pattern).
    const seen = get(
      `SELECT id FROM knowledge WHERE project_id=? AND kind='procedural' AND key=?`,
      task.project_id, `pattern:${task.kind}`
    );
    if (!seen && task.project_id) {
      appendKnowledge(task.project_id, {
        kind: "procedural",
        key: `pattern:${task.kind}`,
        value: `A '${task.kind}' task succeeded and verified via '${vres?.method}'. Reusable: ${task.title}.`,
        provenance: `task ${task.id}`,
        confidence: 0.7,
      });
    }
    return;
  }

  // failure path
  metric("task_failure", 1, { kind: task.kind });
  const gap = classifyGap(task, result, vres);
  emit("learn.gap", { task_id: task.id, level: "warn", message: `gap: ${gap}`, data: { gap } });

  // Count similar prior failures -> escalate twice-repeated failures into a guardrail/eval.
  const priors = get(
    `SELECT COUNT(*) n FROM events WHERE type='task.failed' AND message LIKE ?`,
    `%${task.title.slice(0, 40)}%`
  ).n;
  if (priors >= 1) {
    addQueueItem("improve", {
      title: `Guardrail/eval for repeated failure: ${task.title.slice(0, 60)}`,
      priority: 3,
      note: `gap=${gap}; failed ${priors + 1}x; convert into an eval scenario or deterministic rail.`,
    });
  } else {
    addQueueItem("improve", {
      title: `Investigate failure: ${task.title.slice(0, 60)}`,
      priority: 4,
      note: `gap=${gap}`,
    });
  }
}

// Scaffold for the background one-change loop (fleshed out in M4). Picks ONE candidate.
export function pickImprovement() {
  return get(`SELECT * FROM queue_items WHERE queue='improve' AND status='open' ORDER BY priority ASC, created_at ASC LIMIT 1`);
}
