// Idempotent effect layer + saga orchestration. Real-world workflows mutate multiple external
// systems (CRM, billing, email, ledger). Retries aren't enough: every side effect carries an
// idempotency key (no double-apply) and a compensating action. A saga applies steps in order;
// on ANY failure it compensates the already-committed steps in REVERSE order, so partial failure
// never leaves invisible half-complete state. Think sagas, not one-shot optimism.
import { run, get, all, J, P } from "../db.mjs";
import { id, idempotencyKey } from "../ids.mjs";
import { nowIso } from "../config.mjs";
import { emit } from "../events.mjs";

// effect: { kind, keyParts:[...], payload, do(payload)=>result, compensate(payload,result)=>void }
export function applyEffect(effect, { sagaId = null, step = 0 } = {}) {
  const key = idempotencyKey(effect.kind, ...(effect.keyParts || [effect.payload]));
  // Idempotency: a committed effect with this key is never re-applied.
  const existing = get(`SELECT * FROM effects WHERE idempotency_key=? AND status='committed' LIMIT 1`, key);
  if (existing) {
    emit("effect.idempotent_hit", { message: `${effect.kind} already committed (${key})`, data: { key } });
    return { status: "committed", idempotent: true, id: existing.id, key, result: P(existing.result) };
  }
  const eid = id("eff");
  run(`INSERT INTO effects (id,saga_id,idempotency_key,kind,step,status,payload,ts,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, eid, sagaId, key, effect.kind, step, "attempted", J(effect.payload), nowIso(), nowIso());
  emit("effect.attempted", { message: `${effect.kind} (step ${step})` });
  try {
    const result = effect.do ? effect.do(effect.payload) : null;
    run(`UPDATE effects SET status='committed', result=?, updated_at=? WHERE id=?`, J(result), nowIso(), eid);
    emit("effect.committed", { level: "success", message: `${effect.kind} committed` });
    return { status: "committed", id: eid, key, result };
  } catch (e) {
    run(`UPDATE effects SET status='failed', error=?, updated_at=? WHERE id=?`, e.message, nowIso(), eid);
    emit("effect.failed", { level: "error", message: `${effect.kind} failed: ${e.message}` });
    return { status: "failed", id: eid, key, error: e.message };
  }
}

function compensate(effectId, def) {
  const rec = get(`SELECT * FROM effects WHERE id=?`, effectId);
  if (!rec || rec.status !== "committed") return false;
  try {
    if (def.compensate) def.compensate(P(rec.payload), P(rec.result));
    run(`UPDATE effects SET status='compensated', updated_at=? WHERE id=?`, nowIso(), effectId);
    emit("effect.compensated", { level: "warn", message: `${rec.kind} compensated (rolled back)` });
    return true;
  } catch (e) {
    emit("effect.compensate_failed", { level: "error", message: `${rec.kind} compensation FAILED: ${e.message}` });
    return false;
  }
}

// Run a saga. steps: array of effect defs. Returns { sagaId, status, ... }.
export function runSaga(name, steps) {
  const sagaId = id("saga");
  run(`INSERT INTO sagas (id,name,status,steps,ts) VALUES (?,?,?,?,?)`, sagaId, name, "running", steps.length, nowIso());
  emit("saga.started", { message: `${name} (${steps.length} steps)` });

  const applied = []; // { id, def }
  for (let i = 0; i < steps.length; i++) {
    const r = applyEffect(steps[i], { sagaId, step: i });
    if (r.status === "committed") {
      applied.push({ id: r.id, def: steps[i] });
    } else {
      // Failure: compensate committed steps in REVERSE order.
      let comp = 0;
      for (const a of [...applied].reverse()) if (compensate(a.id, a.def)) comp++;
      run(`UPDATE sagas SET status='compensated', committed=?, compensated=?, failed_step=?, error=?, ended_at=? WHERE id=?`,
        applied.length, comp, i, r.error, nowIso(), sagaId);
      emit("saga.compensated", { level: "warn", message: `${name}: failed at step ${i}, rolled back ${comp} step(s)` });
      return { sagaId, status: "compensated", failedStep: i, error: r.error, committed: applied.length, compensated: comp };
    }
  }
  run(`UPDATE sagas SET status='committed', committed=?, ended_at=? WHERE id=?`, applied.length, nowIso(), sagaId);
  emit("saga.committed", { level: "success", message: `${name}: all ${applied.length} steps committed` });
  return { sagaId, status: "committed", committed: applied.length };
}

export function listSagas(limit = 20) {
  return all(`SELECT * FROM sagas ORDER BY ts DESC LIMIT ?`, limit);
}
export function listEffects(sagaId) {
  return sagaId
    ? all(`SELECT * FROM effects WHERE saga_id=? ORDER BY step ASC`, sagaId).map((e) => ({ ...e, payload: P(e.payload), result: P(e.result) }))
    : all(`SELECT * FROM effects ORDER BY ts DESC LIMIT 30`).map((e) => ({ ...e, payload: P(e.payload), result: P(e.result) }));
}
