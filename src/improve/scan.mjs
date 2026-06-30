// Proactive monitoring -> momentum. Scan live state for neglected work and convert signals
// into queue items so the system notices stalls without being told.
import { all, get } from "../db.mjs";
import { addQueueItem, writeMirror } from "../core/queues.mjs";
import { emit } from "../events.mjs";

export function proactiveScan() {
  const created = [];
  const note = (queue, title, n) => { addQueueItem(queue, { title, note: n, priority: 3 }); created.push(title); };

  // Blocked / awaiting approval.
  const blocked = all(`SELECT id,title,status FROM tasks WHERE status IN ('blocked','needs_approval')`);
  for (const t of blocked) note("blocked", `Unblock: ${t.title} (${t.status})`, `task ${t.id}`);

  // Terminal failures lacking a follow-up.
  const failed = all(`SELECT id,title FROM tasks WHERE status='failed'`);
  for (const t of failed) note("improve", `Resolve failed task: ${t.title.slice(0, 50)}`, `task ${t.id}`);

  // Active goals with no runnable tasks left (possible stall).
  const goals = all(`SELECT id,description FROM goals WHERE status='active'`);
  for (const g of goals) {
    const open = get(`SELECT COUNT(*) n FROM tasks WHERE goal_id=? AND status IN ('pending','claimed','running','verifying')`, g.id).n;
    if (open === 0) note("next", `Define next step for stalled goal: ${g.description.slice(0, 50)}`, `goal ${g.id}`);
  }

  // Eval freshness.
  const lastEval = get(`SELECT started_at FROM eval_runs ORDER BY started_at DESC LIMIT 1`);
  const stale = !lastEval || Date.now() - Date.parse(lastEval.started_at) > 24 * 3600 * 1000;
  if (stale) note("improve", "Run eval suite (no run in last 24h)", "eval freshness");

  writeMirror();
  emit("scan.completed", { message: `${created.length} momentum items`, data: { created } });
  return created;
}
