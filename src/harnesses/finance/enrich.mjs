// Optional LLM enrichment for the finance harness — a narrative summary layered ON TOP of the
// deterministic numbers. The doctrine: deterministic rails + LLM judgment only where it adds
// value, BEHIND a schema/consistency gate. The gate (validateNarrative) is what keeps an LLM
// narrative trustworthy — it must reference the computed risk and must not contradict the figures.
// The LLM call itself reuses the gated `claude` executor; this module is the prompt + the gate.

export function enrichPrompt(reportMd, summary) {
  return (
    "Write a 3-4 sentence executive narrative for this financial report. Be precise and do NOT " +
    "contradict the figures. You MUST state the overall risk level and reference the material " +
    "variances and any reconciliation discrepancies.\n\n" +
    `COMPUTED SUMMARY (authoritative): ${JSON.stringify(summary)}\n\nREPORT:\n${reportMd}`
  );
}

// Consistency gate: reject a narrative that contradicts the authoritative computed summary.
export function validateNarrative(narrative, summary) {
  const t = String(narrative || "").toLowerCase();
  const reasons = [];
  if (!t.includes(String(summary.riskLevel).toLowerCase())) reasons.push(`does not state the risk level (${summary.riskLevel})`);
  const claimsClean = /(no discrepanc|fully reconcile|all (figures|accounts) reconcile|nothing to flag)/.test(t) && !/except|however|but /.test(t);
  if (summary.discrepancies > 0 && claimsClean) reasons.push("claims clean reconciliation despite discrepancies");
  const claimsNoMaterial = /(no material|within budget|on budget|no significant variance)/.test(t);
  if (summary.material > 0 && claimsNoMaterial) reasons.push("claims no material variance despite material findings");
  return { ok: reasons.length === 0, reasons };
}
