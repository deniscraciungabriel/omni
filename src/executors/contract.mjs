// Contract-review executor: one phase of the specialized harness per call. Reads the prior
// phase's artifact from the workspace, runs deterministic logic, writes a schema-checked
// artifact. Every phase leaves a file trail -> resumable + inspectable. State flows via files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, extractClauses, reviewClauses, validate, synthesize } from "../harnesses/contract/logic.mjs";

export const name = "contract";
export const handles = ["contract"];

const PLAYBOOK = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../harnesses/contract/playbook.json"), "utf8")
);

const read = (ws, f) => fs.readFileSync(path.join(ws, f), "utf8");
const readJson = (ws, f) => JSON.parse(read(ws, f));
const write = (ws, f, data) => fs.writeFileSync(path.join(ws, f), typeof data === "string" ? data : JSON.stringify(data, null, 2));

export async function execute(task, ctx) {
  const ws = ctx.workspaceDir;
  const phase = task.spec?.phase;
  try {
    switch (phase) {
      case "classify": {
        const out = classify(read(ws, "input.txt"), PLAYBOOK);
        write(ws, "01-classify.json", out);
        return { ok: true, exitCode: 0, summary: `classified as ${out.docType}, ${out.parties.length} parties`, artifacts: [{ path: "01-classify.json", kind: "json" }] };
      }
      case "extract": {
        const clauses = extractClauses(read(ws, "input.txt"), PLAYBOOK);
        write(ws, "02-clauses.json", clauses);
        const cats = [...new Set(clauses.map((c) => c.category))];
        return { ok: true, exitCode: 0, summary: `extracted ${clauses.length} clauses (${cats.join(", ")})`, artifacts: [{ path: "02-clauses.json", kind: "json" }] };
      }
      case "review": {
        const clauses = readJson(ws, "02-clauses.json");
        const findings = reviewClauses(clauses, PLAYBOOK);
        write(ws, "03-findings.json", findings);
        const issues = findings.filter((f) => f.status !== "pass").length;
        return { ok: true, exitCode: 0, summary: `${findings.length} rules checked, ${issues} issues`, artifacts: [{ path: "03-findings.json", kind: "json" }] };
      }
      case "validate": {
        const cls = readJson(ws, "01-classify.json");
        const clauses = readJson(ws, "02-clauses.json");
        const findings = readJson(ws, "03-findings.json");
        const v = validate(cls, clauses, findings, PLAYBOOK);
        write(ws, "04-validation.json", v);
        if (!v.valid) return { ok: false, exitCode: 1, summary: "findings failed schema validation" };
        return { ok: true, exitCode: 0, summary: `risk ${v.riskScore} (${v.riskLevel}); missing: ${v.missing.join(",") || "none"}`, artifacts: [{ path: "04-validation.json", kind: "json" }] };
      }
      case "synthesize": {
        const cls = readJson(ws, "01-classify.json");
        const clauses = readJson(ws, "02-clauses.json");
        const findings = readJson(ws, "03-findings.json");
        const v = readJson(ws, "04-validation.json");
        const report = synthesize(cls, clauses, findings, v);
        write(ws, "report.md", report);
        write(ws, "05-summary.json", { docType: cls.docType, riskScore: v.riskScore, riskLevel: v.riskLevel, issues: findings.filter((f) => f.status !== "pass").length, missing: v.missing });
        return { ok: true, exitCode: 0, summary: `report.md generated (risk ${v.riskLevel})`, artifacts: [{ path: "report.md", kind: "report" }, { path: "05-summary.json", kind: "json" }] };
      }
      default:
        return { ok: false, exitCode: 1, summary: `unknown contract phase: ${phase}` };
    }
  } catch (e) {
    return { ok: false, exitCode: 1, summary: `phase ${phase} failed: ${e.message}` };
  }
}
