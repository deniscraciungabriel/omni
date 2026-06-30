// Event log + in-process pub/sub. Every meaningful lifecycle moment becomes an event:
// it lands in the DB (durable, queryable) and is pushed to live subscribers (SSE feed).
import { EventEmitter } from "node:events";
import { run, all, J } from "./db.mjs";
import { id } from "./ids.mjs";
import { nowIso } from "./config.mjs";

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emit(type, fields = {}) {
  const ev = {
    id: id("ev"),
    ts: nowIso(),
    type,
    level: fields.level || "info",
    goal_id: fields.goal_id || null,
    task_id: fields.task_id || null,
    session_id: fields.session_id || null,
    project_id: fields.project_id || null,
    message: fields.message || "",
    data: fields.data || null,
  };
  run(
    `INSERT INTO events (id,ts,type,level,goal_id,task_id,session_id,project_id,message,data)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ev.id, ev.ts, ev.type, ev.level, ev.goal_id, ev.task_id, ev.session_id,
    ev.project_id, ev.message, J(ev.data)
  );
  bus.emit("event", ev);
  return ev;
}

export function metric(name, value, dims = {}) {
  run(
    `INSERT INTO metrics (id,ts,name,value,dims) VALUES (?,?,?,?,?)`,
    id("m"), nowIso(), name, value, J(dims)
  );
}

export function recentEvents(limit = 50) {
  return all(`SELECT * FROM events ORDER BY ts DESC LIMIT ?`, limit);
}
