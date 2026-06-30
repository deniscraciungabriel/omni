// Incident/recovery harness — pure phase logic. Triage → diagnose (runbook patterns) → build
// mitigation actions (executed as a SAGA so a failed remediation rolls back) → verify recovery →
// postmortem. Deterministic; the saga integration lives in the executor.
import { nowIso } from "../../config.mjs";

const lc = (s) => String(s || "").toLowerCase();
const symptomText = (inc) => lc((inc.symptoms || []).join(" ") + " " + (inc.title || ""));

// Phase 1 — triage: severity + affected systems.
export function triage(inc, runbook) {
  const errorRate = inc.metrics?.errorRatePct ?? 0;
  const affects = (inc.affectedSystems || []).map(lc);
  let level = "sev4";
  for (const rule of runbook.severity) {
    if (rule.default) { level = rule.level; break; }
    const w = rule.when || {};
    if (w.errorRateGte != null && errorRate >= w.errorRateGte) { level = rule.level; break; }
    if (w.affects && affects.includes(lc(w.affects))) { level = rule.level; break; }
  }
  return { severity: level, title: inc.title || "Incident", affected: inc.affectedSystems || [], errorRatePct: errorRate, detectedAt: nowIso() };
}

// Phase 2 — diagnose: score runbook patterns against the signal.
export function diagnose(inc, runbook) {
  const errorRate = inc.metrics?.errorRatePct ?? 0;
  const text = symptomText(inc);
  const hypotheses = [];
  for (const p of runbook.patterns) {
    const w = p.when || {};
    let match = true;
    if (w.recentDeploy != null && !!inc.recentDeploy !== w.recentDeploy) match = false;
    if (w.errorRateGte != null && errorRate < w.errorRateGte) match = false;
    if (w.symptom && !text.includes(lc(w.symptom))) match = false;
    if (match) hypotheses.push({ cause: p.cause, confidence: p.confidence, mitigations: p.mitigations, evidence: w });
  }
  hypotheses.sort((a, b) => b.confidence - a.confidence);
  return { hypotheses, topCause: hypotheses[0]?.cause || "unknown", mitigations: hypotheses[0]?.mitigations || [] };
}

// Initial simulated infra state derived from the incident.
export function initialInfra(inc) {
  const text = symptomText(inc);
  return {
    errorRatePct: inc.metrics?.errorRatePct ?? 0,
    deployedVersion: inc.recentDeploy ? "vNEW(suspect)" : "vStable",
    dbHealthy: !text.includes("db") && !text.includes("database"),
    latencyP99Ms: inc.metrics?.latencyP99Ms ?? 200,
  };
}

// Map mitigation names -> saga steps that mutate the infra object (each with compensation).
export function buildMitigationSteps(infra, mitigations, opts = {}) {
  const snap = () => JSON.stringify(infra);
  const restoreFrom = (s) => Object.assign(infra, JSON.parse(s));
  const fail = (name) => opts.failMitigation === name;
  const ACTIONS = {
    rollback_deploy: () => { infra.deployedVersion = "vStable"; infra.errorRatePct = 2; },
    failover_db: () => { infra.dbHealthy = true; infra.errorRatePct = Math.min(infra.errorRatePct, 3); },
    restart_service: () => { infra.errorRatePct = Math.max(2, Math.round(infra.errorRatePct / 3)); },
    scale_up: () => { infra.latencyP99Ms = Math.round(infra.latencyP99Ms / 2); },
  };
  // Idempotency keys MUST be scoped to this incident instance — a global key would treat a
  // different incident's "rollback_deploy" as already-done (real bug caught in M9).
  const scope = opts.scope || "global";
  return mitigations.map((m) => {
    let before;
    return {
      kind: `mitigate.${m}`, keyParts: [scope, m, infra.deployedVersion], payload: { action: m },
      do: () => { before = snap(); if (fail(m)) throw new Error(`${m} failed (simulated)`); (ACTIONS[m] || (() => {}))(); return { action: m }; },
      compensate: () => { if (before) restoreFrom(before); },
    };
  });
}

// Phase 4 — verify recovery from the (post-mitigation) infra state.
export function verifyRecovery(infra) {
  const recovered = infra.errorRatePct <= 5 && infra.dbHealthy;
  return { recovered, errorRatePct: infra.errorRatePct, dbHealthy: infra.dbHealthy, at: nowIso() };
}

// Phase 5 — templated postmortem.
export function postmortem(triageRes, diag, mitigation, recovery) {
  const actions = (mitigation.applied || []).map((a) => `- ${a}`).join("\n") || "- _(none)_";
  return `# Postmortem — ${triageRes.title}
_Generated ${nowIso()} · omni incident harness_

- Severity: **${triageRes.severity}**
- Affected: ${triageRes.affected.join(", ") || "n/a"}
- Root cause (top hypothesis): **${diag.topCause}**
- Mitigation saga: **${mitigation.sagaStatus}** ${mitigation.sagaStatus === "compensated" ? "(remediation failed → rolled back)" : ""}
- Recovery: **${recovery.recovered ? "RECOVERED" : "NOT RECOVERED"}** (error rate ${recovery.errorRatePct}%)

## Timeline
- ${triageRes.detectedAt} — detected, triaged ${triageRes.severity}
- diagnosed → ${diag.topCause}
- mitigation → ${mitigation.sagaStatus}
- recovery check → ${recovery.recovered ? "healthy" : "still degraded"}

## Mitigations attempted
${actions}

## Action items
- ${diag.topCause === "bad_deploy" ? "Add a deploy canary + automated rollback gate." : "Add an automated runbook check for " + diag.topCause + "."}
- Add an alert + eval for this failure signature.
`;
}
