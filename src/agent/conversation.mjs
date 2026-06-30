// Conversation persistence. The entity remembers what you said across turns and sessions —
// chat history is durable in the DB, not held only in volatile context.
import { run, get, all, J } from "../db.mjs";
import { id } from "../ids.mjs";
import { nowIso } from "../config.mjs";

export function startConversation(title = "chat") {
  const cid = id("conv");
  run(`INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)`, cid, title, nowIso(), nowIso());
  return cid;
}

export function latestConversation() {
  const r = get(`SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1`);
  return r ? r.id : startConversation();
}

export function addMessage(cid, role, content, { intent = null, meta = null } = {}) {
  run(`INSERT INTO messages (id,conversation_id,role,content,intent,meta,ts) VALUES (?,?,?,?,?,?,?)`,
    id("msg"), cid, role, content, intent, J(meta), nowIso());
  run(`UPDATE conversations SET updated_at=? WHERE id=?`, nowIso(), cid);
}

export function history(cid, limit = 20) {
  return all(`SELECT role, content FROM messages WHERE conversation_id=? ORDER BY ts ASC LIMIT ?`, cid, limit);
}

export function recentTurns(cid, limit = 8) {
  return all(`SELECT role, content FROM messages WHERE conversation_id=? ORDER BY ts DESC LIMIT ?`, cid, limit)
    .reverse();
}
