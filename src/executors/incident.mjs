// Incident-recovery executor. The `mitigate` phase runs remediation as a SAGA (M8) so a failed
// fix rolls back instead of leaving infra half-changed. Each phase leaves a schema-checked artifact.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { triage, diagnose, initialInfra, buildMitigationSteps, verifyRecovery, postmortem } from "../harnesses/incident/logic.mjs";
import { runSaga } from "../effects/effects.mjs";

export const name = "incident";
export const handles = ["incident"];

const RUNBOOK = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../harnesses/incident/runbook.json"), "utf8")
);
const read = (ws, f) => fs.readFileSync(path.join(ws, f), "utf8");
const readJson = (ws, f) => JSON.parse(read(ws, f));
const write = (ws, f, d) => fs.writeFileSync(path.join(ws, f), typeof d === "string" ? d : JSON.stringify(d, null, 2));

export async function execute(task, ctx) {
  const ws = ctx.workspaceDir;
  const phase = task.spec?.phase;
  try {
    const inc = () => readJson(ws, "input.json");
    switch (phase) {
      case "triage": {
        const t = triage(inc(), RUNBOOK);
        write(ws, "01-triage.json", t);
        write(ws, "infra.json", initialInfra(inc()));
        return { ok: true, exitCode: 0, summary: `${t.severity}: ${t.title}`, artifacts: [{ path: "01-triage.json", kind: "json" }] };
      }
      case "diagnose": {
        const d = diagnose(inc(), RUNBOOK);
        write(ws, "02-diagnose.json", d);
        return { ok: true, exitCode: 0, summary: `top cause: ${d.topCause} (${d.mitigations.join(", ") || "no mitigations"})`, artifacts: [{ path: "02-diagnose.json", kind: "json" }] };
      }
      case "mitigate": {
        const d = readJson(ws, "02-diagnose.json");
        const infra = readJson(ws, "infra.json");
        const steps = buildMitigationSteps(infra, d.mitigations, { failMitigation: task.spec?.failMitigation, scope: task.goal_id });
        const saga = runSaga(`incident:${task.goal_id}`, steps);
        write(ws, "infra.json", infra); // persist post-saga (committed or rolled-back) state
        const applied = saga.status === "committed" ? d.mitigations : [];
        write(ws, "03-mitigation.json", { sagaStatus: saga.status, applied, failedStep: saga.failedStep ?? null, compensated: saga.compensated ?? 0 });
        return { ok: true, exitCode: 0, summary: `mitigation saga ${saga.status} (${applied.length} applied)`, artifacts: [{ path: "03-mitigation.json", kind: "json" }] };
      }
      case "verify": {
        const r = verifyRecovery(readJson(ws, "infra.json"));
        write(ws, "04-recovery.json", r);
        return { ok: true, exitCode: 0, summary: r.recovered ? "RECOVERED" : `still degraded (err ${r.errorRatePct}%)`, artifacts: [{ path: "04-recovery.json", kind: "json" }] };
      }
      case "postmortem": {
        const t = readJson(ws, "01-triage.json");
        const d = readJson(ws, "02-diagnose.json");
        const m = readJson(ws, "03-mitigation.json");
        const r = readJson(ws, "04-recovery.json");
        write(ws, "report.md", postmortem(t, d, m, r));
        write(ws, "05-summary.json", { severity: t.severity, rootCause: d.topCause, sagaStatus: m.sagaStatus, recovered: r.recovered });
        return { ok: true, exitCode: 0, summary: `postmortem written (recovered=${r.recovered})`, artifacts: [{ path: "report.md", kind: "report" }] };
      }
      default:
        return { ok: false, exitCode: 1, summary: `unknown incident phase: ${phase}` };
    }
  } catch (e) {
    return { ok: false, exitCode: 1, summary: `phase ${phase} failed: ${e.message}` };
  }
}
