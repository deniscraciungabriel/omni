// Finance-reporting executor: one phase per call. Reads the prior phase's artifact, runs
// deterministic logic, writes a schema-checked artifact. Same harness pattern as contract.
import fs from "node:fs";
import path from "node:path";
import { ingest, reconcile, analyze, validate, synthesize } from "../harnesses/finance/logic.mjs";
import { enrichPrompt, validateNarrative } from "../harnesses/finance/enrich.mjs";
import { callClaude } from "./claude.mjs";
import { checkDailyBudget } from "../core/governance.mjs";
import { POLICY } from "../config.mjs";

export const name = "finance";
export const handles = ["finance"];

const read = (ws, f) => fs.readFileSync(path.join(ws, f), "utf8");
const readJson = (ws, f) => JSON.parse(read(ws, f));
const write = (ws, f, d) => fs.writeFileSync(path.join(ws, f), typeof d === "string" ? d : JSON.stringify(d, null, 2));

export async function execute(task, ctx) {
  const ws = ctx.workspaceDir;
  const phase = task.spec?.phase;
  try {
    switch (phase) {
      case "ingest": {
        const out = ingest(read(ws, "input.csv"));
        write(ws, "01-ingest.json", out);
        return { ok: true, exitCode: 0, summary: `ingested ${out.records.length} rows, ${out.errors.length} errors`, artifacts: [{ path: "01-ingest.json", kind: "json" }] };
      }
      case "reconcile": {
        const { records } = readJson(ws, "01-ingest.json");
        const out = reconcile(records);
        write(ws, "02-reconcile.json", out);
        const d = out.filter((r) => r.status !== "ok").length;
        return { ok: true, exitCode: 0, summary: `reconciled ${out.length} rows, ${d} discrepancies`, artifacts: [{ path: "02-reconcile.json", kind: "json" }] };
      }
      case "analyze": {
        const { records } = readJson(ws, "01-ingest.json");
        const out = analyze(records);
        write(ws, "03-analysis.json", out);
        return { ok: true, exitCode: 0, summary: `variance: ${out.totals.variancePct}% overall, ${out.byAccount.filter((a) => a.material).length} material`, artifacts: [{ path: "03-analysis.json", kind: "json" }] };
      }
      case "validate": {
        const ing = readJson(ws, "01-ingest.json");
        const rec = readJson(ws, "02-reconcile.json");
        const an = readJson(ws, "03-analysis.json");
        const v = validate(ing, rec, an);
        write(ws, "04-validation.json", v);
        if (!v.valid) return { ok: false, exitCode: 1, summary: "validation schema check failed" };
        return { ok: true, exitCode: 0, summary: `risk ${v.riskLevel}; ${v.discrepancies} disc, ${v.materialVariances} material`, artifacts: [{ path: "04-validation.json", kind: "json" }] };
      }
      case "report": {
        const ing = readJson(ws, "01-ingest.json");
        const rec = readJson(ws, "02-reconcile.json");
        const an = readJson(ws, "03-analysis.json");
        const v = readJson(ws, "04-validation.json");
        const report = synthesize(ing, rec, an, v);
        write(ws, "report.md", report);
        write(ws, "05-summary.json", { riskLevel: v.riskLevel, totals: an.totals, discrepancies: v.discrepancies, material: v.materialVariances });
        return { ok: true, exitCode: 0, summary: `report.md generated (risk ${v.riskLevel})`, artifacts: [{ path: "report.md", kind: "report" }] };
      }
      case "enrich": {
        // Optional LLM narrative behind a consistency gate, with a self-correction loop.
        // Best-effort: the deterministic report is the deliverable; a failing narrative is
        // never published. Skips cleanly (no spend) when the engine is gated.
        const summary = readJson(ws, "05-summary.json");
        if (!POLICY.allowClaude) {
          write(ws, "06-enrich.json", { status: "skipped", reason: "LLM gated (set OMNI_ALLOW_CLAUDE=1)" });
          return { ok: true, exitCode: 0, summary: "enrichment skipped (gated); deterministic report stands", artifacts: [{ path: "06-enrich.json", kind: "json" }] };
        }
        const budget = checkDailyBudget();
        if (!budget.ok) {
          write(ws, "06-enrich.json", { status: "skipped", reason: `daily budget exceeded ($${budget.spent.toFixed(2)}/$${budget.limit})` });
          return { ok: true, exitCode: 0, summary: "enrichment skipped (daily budget); deterministic report stands", artifacts: [{ path: "06-enrich.json", kind: "json" }] };
        }
        const report = read(ws, "report.md");
        let feedback = "", totalCost = 0, attempts = 0;
        const maxAttempts = 2;
        for (attempts = 1; attempts <= maxAttempts; attempts++) {
          const prompt = enrichPrompt(report, summary) + (feedback ? `\n\nYOUR PREVIOUS DRAFT WAS REJECTED BECAUSE: ${feedback}. Fix exactly these issues.` : "");
          const r = callClaude(prompt, { cwd: ws, runDir: ctx.runDir, label: `enrich${attempts}` });
          totalCost += r.cost || 0;
          if (!r.ok) {
            write(ws, "06-enrich.json", { status: "error", attempts, error: r.error || "claude call failed" });
            return { ok: true, exitCode: 0, cost: totalCost, summary: "enrichment call failed; deterministic report stands", artifacts: [{ path: "06-enrich.json", kind: "json" }] };
          }
          const gate = validateNarrative(r.text, summary);
          if (gate.ok) {
            write(ws, "narrative.md", r.text.trim() + "\n");
            write(ws, "06-enrich.json", { status: "passed", attempts, cost: +totalCost.toFixed(4) });
            return { ok: true, exitCode: 0, cost: totalCost, summary: `narrative passed consistency gate (attempt ${attempts})`, artifacts: [{ path: "narrative.md", kind: "report" }, { path: "06-enrich.json", kind: "json" }] };
          }
          feedback = gate.reasons.join("; ");
        }
        write(ws, "06-enrich.json", { status: "rejected", attempts: maxAttempts, reasons: feedback });
        return { ok: true, exitCode: 0, cost: totalCost, summary: `narrative rejected by gate after ${maxAttempts} attempts; deterministic report stands`, artifacts: [{ path: "06-enrich.json", kind: "json" }] };
      }
      default:
        return { ok: false, exitCode: 1, summary: `unknown finance phase: ${phase}` };
    }
  } catch (e) {
    return { ok: false, exitCode: 1, summary: `phase ${phase} failed: ${e.message}` };
  }
}
