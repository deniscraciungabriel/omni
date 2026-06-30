// Background one-change loop: make ONE bounded change, measure it against the eval suite, and
// KEEP only if it improved without regressing — otherwise AUTO-REVERT. A file-snapshot safety
// net guarantees revert restores exact prior state even if the candidate's own logic is wrong.
import fs from "node:fs";
import { run } from "../db.mjs";
import { id } from "../ids.mjs";
import { nowIso } from "../config.mjs";
import { emit } from "../events.mjs";
import { appendKnowledge } from "../memory/memory.mjs";
import { addQueueItem } from "../core/queues.mjs";

// Pure decision logic (unit-testable without running evals).
// Revert on ANY regression (new failures or lower pass rate). Keep only on a real gain
// (higher pass rate or added coverage), or equal when the candidate opts in (keepOnEqual).
export function decide(baseline, after, candidate = {}) {
  const regression = after.error || after.failed > baseline.failed || after.pass_rate < baseline.pass_rate;
  if (regression) return "reverted_regression";
  const improved = after.pass_rate > baseline.pass_rate || after.total > baseline.total;
  if (improved || candidate.keepOnEqual) return "kept";
  return "reverted_no_gain";
}

function snapshot(files = []) {
  return files.map((p) => ({ path: p, existed: fs.existsSync(p), content: fs.existsSync(p) ? fs.readFileSync(p) : null }));
}
function restore(snaps) {
  for (const s of snaps) {
    if (s.existed) fs.writeFileSync(s.path, s.content);
    else if (fs.existsSync(s.path)) fs.rmSync(s.path, { force: true });
  }
}

// candidate: { name, hypothesis, files:[paths it may touch], apply:()=>void|Promise, keepOnEqual?:bool }
export async function runOneChange(candidate) {
  const { runEvals } = await import("../../evals/run-evals.mjs");
  const snaps = snapshot(candidate.files || []);
  emit("improve.start", { message: `one-change: ${candidate.name}` });

  const baseline = await runEvals("baseline");
  let after, error = null;
  try {
    await candidate.apply();
    after = await runEvals("candidate");
  } catch (e) {
    error = e.message;
    after = { pass_rate: 0, failed: baseline.failed + 1, total: baseline.total, passed: 0, error: true };
  }

  const decision = decide(baseline, { ...after, error }, candidate);
  if (decision !== "kept") restore(snaps);

  run(`INSERT INTO improvements (id,name,hypothesis,baseline_pass,after_pass,baseline_total,after_total,decision,error,ts)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id("imp"), candidate.name, candidate.hypothesis || "", baseline.pass_rate, after.pass_rate,
    baseline.total, after.total, decision, error, nowIso());

  emit("improve.decision", {
    level: decision === "kept" ? "success" : "warn",
    message: `${candidate.name}: ${decision} (pass ${baseline.passed}/${baseline.total} -> ${after.passed ?? "?"}/${after.total})`,
    data: { decision },
  });

  if (decision === "kept" && candidate.knowledgeProject) {
    appendKnowledge(candidate.knowledgeProject, {
      kind: "procedural", key: `improvement:${candidate.name}`,
      value: `${candidate.hypothesis} — adopted (evals ${after.passed}/${after.total}).`, confidence: 0.8,
    });
  }
  if (decision === "reverted_regression") {
    addQueueItem("improve", { title: `Reverted regressive change: ${candidate.name}`, priority: 3, note: error || "evals regressed; needs a different approach" });
  }
  return { decision, baseline: { pass_rate: baseline.pass_rate, total: baseline.total, passed: baseline.passed }, after: { pass_rate: after.pass_rate, total: after.total, passed: after.passed }, error };
}
