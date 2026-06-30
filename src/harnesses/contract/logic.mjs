// Contract review — pure phase logic (deterministic, testable, no LLM, no external deps).
// Each phase consumes the prior phase's structured output. Reliability comes from rails +
// schemas + validation, not from prompting. An LLM enrichment step can layer on later.
import { nowIso } from "../../config.mjs";

const lc = (s) => String(s || "").toLowerCase();

// Phase 1 — classify the document + pull light metadata.
export function classify(text, playbook) {
  const t = lc(text);
  let docType = "generic", best = 0;
  for (const [type, kws] of Object.entries(playbook.doc_types)) {
    const hits = kws.filter((k) => t.includes(lc(k))).length;
    if (hits > best) { best = hits; docType = type; }
  }
  const parties = [];
  const m = text.match(/between\s+([^(,\n]+?)\s*(?:\([^)]*\))?\s+and\s+([^(,\n]+?)\s*(?:\([^)]*\))?(?=\s+as of|[.,\n(])/i);
  if (m) { parties.push(m[1].trim().slice(0, 60), m[2].trim().slice(0, 60)); }
  return { docType, parties, chars: text.length, at: nowIso() };
}

// Phase 2 — segment into clauses and categorize each.
export function extractClauses(text, playbook) {
  const lines = text.split("\n");
  const sections = [];
  let cur = null;
  const headingRe = /^\s*(\d+)\.\s+(.{2,80})$/;
  for (const line of lines) {
    const h = line.match(headingRe);
    if (h) {
      if (cur) sections.push(cur);
      cur = { id: `c${h[1]}`, heading: h[2].trim().replace(/\.$/, ""), text: "" };
    } else if (cur) {
      cur.text += line + "\n";
    }
  }
  if (cur) sections.push(cur);
  // fallback: blank-line paragraphs
  if (!sections.length) {
    text.split(/\n\s*\n/).forEach((p, i) => {
      if (p.trim()) sections.push({ id: `c${i + 1}`, heading: p.trim().slice(0, 50), text: p });
    });
  }
  for (const s of sections) {
    const hay = lc(s.heading + " " + s.text);
    let cat = "other", score = 0;
    for (const [category, kws] of Object.entries(playbook.clause_categories)) {
      const hits = kws.filter((k) => hay.includes(lc(k))).length + (lc(s.heading).includes(category.replace("_", " ")) ? 2 : 0);
      if (hits > score) { score = hits; cat = category; }
    }
    s.category = cat;
    s.text = s.text.trim();
  }
  return sections;
}

// Phase 3 — evaluate clauses against the playbook rules.
export function reviewClauses(clauses, playbook) {
  const byCat = {};
  for (const c of clauses) (byCat[c.category] ||= []).push(c);
  const findings = [];
  for (const rule of playbook.rules) {
    const present = (byCat[rule.category] || []);
    const combined = lc(present.map((c) => c.text + " " + c.heading).join(" "));
    let status;
    if (rule.check === "present") {
      status = present.length ? "pass" : "fail";
    } else {
      const hasKw = (rule.any || []).some((k) => combined.includes(lc(k)));
      if (rule.invert) status = hasKw ? "flag" : "pass";
      else if (!present.length) status = "fail";
      else status = hasKw ? "pass" : "flag";
    }
    findings.push({
      rule: rule.id, category: rule.category, severity: rule.severity, status,
      clauseId: present[0]?.id || null,
      note: status === "pass" ? "" : rule.note,
      remediation: status === "pass" ? "" : rule.remediation,
    });
  }
  return findings;
}

const SEV_WEIGHT = { high: 3, medium: 2, low: 1 };
export function riskLevel(score) {
  if (score === 0) return "clear";
  if (score <= 2) return "low";
  if (score <= 5) return "medium";
  return "high";
}

// Phase 4 — validation gate: required clauses present + schema sanity + risk score.
export function validate(classify, clauses, findings, playbook) {
  const categoriesFound = [...new Set(clauses.map((c) => c.category))];
  const missing = playbook.required_categories.filter((r) => !categoriesFound.includes(r));
  let riskScore = 0;
  for (const f of findings) {
    if (f.status === "flag") riskScore += SEV_WEIGHT[f.severity] || 1;
    if (f.status === "fail") riskScore += (SEV_WEIGHT[f.severity] || 1) + 1;
  }
  const schemaOk = findings.every((f) => f.rule && f.status && f.severity);
  return { categoriesFound, missing, riskScore, riskLevel: riskLevel(riskScore), valid: schemaOk, at: nowIso() };
}

// Phase 5 — programmatic templated report (NOT free-form). Deterministic output every time.
export function synthesize(cls, clauses, findings, validation) {
  const issues = findings.filter((f) => f.status !== "pass");
  const rows = findings
    .map((f) => `| ${f.severity} | ${f.status === "pass" ? "✓ pass" : f.status === "fail" ? "✗ fail" : "⚠ flag"} | ${f.rule} | ${f.note || "ok"} |`)
    .join("\n");
  const redlines = issues.length
    ? issues.map((f) => `- **[${f.severity}/${f.rule}]** ${f.remediation}`).join("\n")
    : "- _(none — all checks passed)_";
  const missing = validation.missing.length ? validation.missing.map((m) => `- ⚠ missing **${m}** clause`).join("\n") : "- _(all required clauses present)_";
  return `# Contract Review — ${cls.docType.toUpperCase()}
_Generated ${nowIso()} · omni contract harness (deterministic)_

- Document type: **${cls.docType}**
- Parties: ${cls.parties.length ? cls.parties.join(" / ") : "_not detected_"}
- Clauses analyzed: **${clauses.length}**
- Risk score: **${validation.riskScore}** (${validation.riskLevel.toUpperCase()})

## Missing required clauses
${missing}

## Findings
| severity | status | rule | note |
|---|---|---|---|
${rows}

## Recommended redlines
${redlines}
`;
}
