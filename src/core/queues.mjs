// Momentum queues. The system should never end a meaningful run with all five undefined:
//   now      -> current active focus
//   next     -> concrete ready-to-run tasks
//   blocked  -> waiting on approval/info/deps
//   improve  -> self-improvement backlog (eval gaps, flaky steps, missing skills)
//   recurring-> schedules/monitors/sweeps that keep the system alive
import fs from "node:fs";
import { run, get, all } from "../db.mjs";
import { id } from "../ids.mjs";
import { nowIso, PATHS } from "../config.mjs";
import { emit } from "../events.mjs";

export const QUEUES = ["now", "next", "blocked", "improve", "recurring"];

export function addQueueItem(queue, item = {}) {
  // de-dupe by (queue, title) when open
  const dup = get(
    `SELECT id FROM queue_items WHERE queue=? AND title=? AND status='open'`,
    queue, item.title
  );
  if (dup) return dup.id;
  const qid = id("q");
  run(
    `INSERT INTO queue_items (id,queue,ref_type,ref_id,title,priority,status,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    qid, queue, item.ref_type || null, item.ref_id || null, item.title,
    item.priority ?? 5, "open", item.note || null, nowIso(), nowIso()
  );
  emit("queue.add", { message: `[${queue}] ${item.title}`, data: { queue } });
  return qid;
}

export function listQueue(queue) {
  return all(`SELECT * FROM queue_items WHERE queue=? AND status='open' ORDER BY priority ASC, created_at ASC`, queue);
}

export function closeQueueItem(qid, note = "") {
  run(`UPDATE queue_items SET status='done', note=?, updated_at=? WHERE id=?`, note, nowIso(), qid);
}

export function allQueues() {
  const out = {};
  for (const q of QUEUES) out[q] = listQueue(q);
  return out;
}

// Recompute now/next/blocked live from the task graph, then mirror everything to disk.
export function syncQueues() {
  // clear derived queues (now/next/blocked are computed; improve/recurring persist)
  run(`UPDATE queue_items SET status='superseded' WHERE queue IN ('now','next','blocked') AND ref_type='task'`);

  const running = all(`SELECT id,title,goal_id FROM tasks WHERE status IN ('running','verifying','claimed') ORDER BY updated_at DESC`);
  for (const t of running) addQueueItem("now", { ref_type: "task", ref_id: t.id, title: t.title });

  const pending = all(`SELECT id,title FROM tasks WHERE status='pending' ORDER BY priority ASC, created_at ASC LIMIT 8`);
  for (const t of pending) addQueueItem("next", { ref_type: "task", ref_id: t.id, title: t.title });

  const blocked = all(`SELECT id,title,status FROM tasks WHERE status IN ('blocked','needs_approval') ORDER BY updated_at DESC`);
  for (const t of blocked) addQueueItem("blocked", { ref_type: "task", ref_id: t.id, title: `${t.title} (${t.status})` });

  writeMirror();
}

export function writeMirror() {
  const data = { updated_at: nowIso(), queues: allQueues() };
  fs.mkdirSync(PATHS.state, { recursive: true });
  fs.writeFileSync(PATHS.queues, JSON.stringify(data, null, 2));
  return data;
}

// Seed durable improve/recurring backlog so momentum never starts empty.
export function ensureBaselineQueues() {
  const seedsImprove = [
    "Add eval coverage for every new task kind",
    "Convert any twice-repeated failure into an eval or guardrail",
    "Mine repeated successful trajectories into a playbook",
    "Run the external-intelligence digest and triage ideas",
  ];
  const seedsRecurring = [
    "Proactive scan: blocked tasks, stale handoffs, pending approvals",
    "Daily: run eval suite and record pass-rate delta",
    "Daily: roll up cost + intervention metrics",
  ];
  for (const s of seedsImprove) addQueueItem("improve", { title: s, priority: 6 });
  for (const s of seedsRecurring) addQueueItem("recurring", { title: s, priority: 6 });
  writeMirror();
}
