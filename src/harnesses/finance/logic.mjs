// Finance / reporting harness — pure phase logic (deterministic, testable, no deps).
// Reliability via rails + schemas + source reconciliation, not prompting. The model summary (if
// any) is an enrichment layer; the numbers and flags are computed in code.
import { nowIso } from "../../config.mjs";

export const CONFIG = { materialPct: 10, reconcileTolerance: 0.005 };

const num = (v) => { const n = Number(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : NaN; };

// Phase 1 — ingest a CSV: period,account,actual,budget,ledger
export function ingest(text) {
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (k) => header.indexOf(k);
  const records = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const rec = {
      period: (cols[idx("period")] || "").trim(),
      account: (cols[idx("account")] || "").trim(),
      actual: num(cols[idx("actual")]),
      budget: num(cols[idx("budget")]),
      ledger: num(cols[idx("ledger")]),
    };
    if (!rec.account || [rec.actual, rec.budget, rec.ledger].some((x) => Number.isNaN(x))) errors.push({ line: i + 1, raw: lines[i] });
    else records.push(rec);
  }
  return { records, errors, at: nowIso() };
}

// Phase 2 — reconcile reported actuals against the authoritative ledger.
export function reconcile(records, cfg = CONFIG) {
  return records.map((r) => {
    const delta = +(r.actual - r.ledger).toFixed(2);
    const status = Math.abs(delta) <= cfg.reconcileTolerance * Math.max(1, Math.abs(r.ledger)) ? "ok" : "discrepancy";
    return { period: r.period, account: r.account, reported: r.actual, ledger: r.ledger, delta, status };
  });
}

// Phase 3 — variance analysis (actual vs budget), aggregated by account.
export function analyze(records, cfg = CONFIG) {
  const byAcct = {};
  for (const r of records) {
    const a = (byAcct[r.account] ||= { account: r.account, actual: 0, budget: 0 });
    a.actual += r.actual; a.budget += r.budget;
  }
  const byAccount = Object.values(byAcct).map((a) => {
    const variance = +(a.actual - a.budget).toFixed(2);
    const variancePct = a.budget ? +((variance / a.budget) * 100).toFixed(1) : 0;
    return { ...a, actual: +a.actual.toFixed(2), budget: +a.budget.toFixed(2), variance, variancePct, material: Math.abs(variancePct) >= cfg.materialPct };
  }).sort((x, y) => Math.abs(y.variancePct) - Math.abs(x.variancePct));
  const totals = byAccount.reduce((t, a) => ({ actual: t.actual + a.actual, budget: t.budget + a.budget }), { actual: 0, budget: 0 });
  totals.variance = +(totals.actual - totals.budget).toFixed(2);
  totals.variancePct = totals.budget ? +((totals.variance / totals.budget) * 100).toFixed(1) : 0;
  totals.actual = +totals.actual.toFixed(2); totals.budget = +totals.budget.toFixed(2);
  return { byAccount, totals };
}

// Phase 4 — validation gate: data quality + reconciliation + materiality => risk.
export function validate(ingestRes, reconciliation, analysis) {
  const discrepancies = reconciliation.filter((r) => r.status !== "ok").length;
  const material = analysis.byAccount.filter((a) => a.material).length;
  const dataQualityOk = ingestRes.errors.length === 0;
  const valid = reconciliation.every((r) => r.status) && Array.isArray(analysis.byAccount);
  let risk = 0;
  risk += discrepancies * 3;
  risk += material * 2;
  risk += dataQualityOk ? 0 : 4;
  const riskLevel = risk === 0 ? "clean" : risk <= 3 ? "low" : risk <= 7 ? "medium" : "high";
  return { discrepancies, materialVariances: material, dataQualityOk, parseErrors: ingestRes.errors.length, valid, risk, riskLevel, at: nowIso() };
}

// Phase 5 — programmatic board-style report.
export function synthesize(ingestRes, reconciliation, analysis, validation) {
  const fmt = (n) => (n < 0 ? "-$" + Math.abs(n).toLocaleString() : "$" + n.toLocaleString());
  const t = analysis.totals;
  const varRows = analysis.byAccount
    .map((a) => `| ${a.account} | ${fmt(a.actual)} | ${fmt(a.budget)} | ${fmt(a.variance)} | ${a.variancePct}% | ${a.material ? "⚠ material" : "ok"} |`)
    .join("\n");
  const disc = reconciliation.filter((r) => r.status !== "ok");
  const discRows = disc.length
    ? disc.map((r) => `- ⚠ **${r.account}** (${r.period}): reported ${fmt(r.reported)} vs ledger ${fmt(r.ledger)} → delta ${fmt(r.delta)}`).join("\n")
    : "- _(all reported figures reconcile to the ledger)_";
  return `# Financial Report — variance & reconciliation
_Generated ${nowIso()} · omni finance harness (deterministic)_

- Risk: **${validation.riskLevel.toUpperCase()}** (score ${validation.risk})
- Data quality: ${validation.dataQualityOk ? "clean" : `${validation.parseErrors} parse error(s)`}
- Reconciliation: ${validation.discrepancies} discrepancy(ies) · Material variances: ${validation.materialVariances}

## Totals
| | Actual | Budget | Variance | Var % |
|---|---|---|---|---|
| **All accounts** | ${fmt(t.actual)} | ${fmt(t.budget)} | ${fmt(t.variance)} | ${t.variancePct}% |

## Variance by account (largest first)
| account | actual | budget | variance | var % | flag |
|---|---|---|---|---|---|
${varRows}

## Source reconciliation (reported vs ledger)
${discRows}
`;
}
