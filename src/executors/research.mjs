// Research/science executor: one phase per call, schema-checked artifact trail. The `reproduce`
// phase independently re-runs from the manifest — a claim isn't accepted unless it reproduces.
import fs from "node:fs";
import path from "node:path";
import { design, runExperiment, analyze, reproduce, report } from "../harnesses/research/logic.mjs";

export const name = "research";
export const handles = ["research_exp"];

const read = (ws, f) => fs.readFileSync(path.join(ws, f), "utf8");
const readJson = (ws, f) => JSON.parse(read(ws, f));
const write = (ws, f, d) => fs.writeFileSync(path.join(ws, f), typeof d === "string" ? d : JSON.stringify(d, null, 2));

export async function execute(task, ctx) {
  const ws = ctx.workspaceDir;
  const phase = task.spec?.phase;
  try {
    const spec = () => readJson(ws, "input.json");
    switch (phase) {
      case "hypothesis": {
        const s = spec();
        write(ws, "01-hypothesis.json", { question: s.question, hypothesis: s.hypothesis, method: s.method, params: s.params });
        return { ok: true, exitCode: 0, summary: `hypothesis: ${(s.hypothesis || s.question || "").slice(0, 60)}`, artifacts: [{ path: "01-hypothesis.json", kind: "json" }] };
      }
      case "design": {
        const d = design(spec());
        write(ws, "02-design.json", d);
        if (!d.valid) return { ok: false, exitCode: 1, summary: `design invalid: ${d.errors.join("; ")}` };
        return { ok: true, exitCode: 0, summary: `design valid; rev ${d.manifest.code_rev}`, artifacts: [{ path: "02-design.json", kind: "json" }] };
      }
      case "run": {
        const d = readJson(ws, "02-design.json");
        const r = runExperiment(d.manifest);
        write(ws, "03-run.json", r);
        return { ok: true, exitCode: 0, summary: `ran ${r.results.length} seeded trials`, artifacts: [{ path: "03-run.json", kind: "json" }] };
      }
      case "analyze": {
        const a = analyze(readJson(ws, "03-run.json"));
        write(ws, "04-analysis.json", a);
        return { ok: true, exitCode: 0, summary: `${a.metric} = ${a.estimate_mean} ± ${a.estimate_std} (err ${a.abs_error})`, artifacts: [{ path: "04-analysis.json", kind: "json" }] };
      }
      case "reproduce": {
        const d = readJson(ws, "02-design.json");
        const orig = readJson(ws, "03-run.json");
        const rep = reproduce(d.manifest, orig);
        write(ws, "05-repro.json", rep);
        return { ok: true, exitCode: 0, summary: rep.reproducible ? "REPRODUCED" : `NOT reproduced (${rep.reason || rep.maxDiff})`, artifacts: [{ path: "05-repro.json", kind: "json" }] };
      }
      case "report": {
        const s = spec();
        const d = readJson(ws, "02-design.json");
        const a = readJson(ws, "04-analysis.json");
        const rep = readJson(ws, "05-repro.json");
        write(ws, "report.md", report(s, d, a, rep));
        write(ws, "06-summary.json", { method: s.method, estimate: a.estimate_mean, std: a.estimate_std, reproducible: rep.reproducible });
        return { ok: true, exitCode: 0, summary: `report written (reproducible=${rep.reproducible})`, artifacts: [{ path: "report.md", kind: "report" }] };
      }
      default:
        return { ok: false, exitCode: 1, summary: `unknown research phase: ${phase}` };
    }
  } catch (e) {
    return { ok: false, exitCode: 1, summary: `phase ${phase} failed: ${e.message}` };
  }
}
