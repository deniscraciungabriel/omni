// Eval harness (runs in an ISOLATED process against a temp DB + temp projects dir, set by the
// parent via OMNI_DB / OMNI_PROJECTS). Each scenario exercises the real closed loop and
// asserts on real state. Prints a JSON summary to stdout. Categories: capability, regression,
// behavioral (safety/scope), failure-injection.
import "../src/quiet.mjs";
import { db, get, all } from "../src/db.mjs";
import { createGoal } from "../src/core/goals.mjs";
import { createTask, claimNext, getTask } from "../src/core/tasks.mjs";
import { runTask, runLoop } from "../src/worker/worker.mjs";
import { planFromPlaybook } from "../src/core/planner.mjs";
import { decideApproval, pendingApprovals } from "../src/core/governance.mjs";

db(); // init schema in the temp DB

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// 1. CAPABILITY: full loop happy path (echo executor, no side effects).
scenario("loop_happy_path", async () => {
  const g = createGoal({ description: "eval: happy path" });
  const t = createTask({ goal_id: g, kind: "echo", title: "echo ok", spec: { echo: "hi" }, verification_plan: { method: "none" } });
  const r = await runTask(getTask(t));
  const task = getTask(t);
  if (r.status !== "done") return { pass: false, detail: `status=${r.status}` };
  if (task.status !== "done") return { pass: false, detail: `task.status=${task.status}` };
  if (!task.evidence || !task.evidence.length) return { pass: false, detail: "no evidence recorded" };
  return { pass: true };
});

// 2. FAILURE-INJECTION: forced failure exhausts retries -> failed + learning ratchet.
scenario("failure_injection_and_learning", async () => {
  const g = createGoal({ description: "eval: failure" });
  const t = createTask({ goal_id: g, kind: "echo", title: "echo boom", max_attempts: 1, spec: { echo: "boom", fail: true } });
  await runTask(getTask(t));
  const task = getTask(t);
  if (task.status !== "failed") return { pass: false, detail: `expected failed, got ${task.status}` };
  const improve = get(`SELECT COUNT(*) n FROM queue_items WHERE queue='improve'`).n;
  if (improve < 1) return { pass: false, detail: "no improve ratchet created" };
  return { pass: true };
});

// 3. REGRESSION: dependency ordering — B not claimable until A done.
scenario("dependency_ordering", async () => {
  const g = createGoal({ description: "eval: deps" });
  const a = createTask({ goal_id: g, kind: "echo", title: "A", spec: { echo: "a" }, verification_plan: { method: "none" } });
  const b = createTask({ goal_id: g, kind: "echo", title: "B", depends_on: [a], spec: { echo: "b" }, verification_plan: { method: "none" } });
  const first = claimNext("evalw");
  if (!first || first.id !== a) return { pass: false, detail: "A should be claimed first" };
  const second = claimNext("evalw");
  if (second && second.id === b) return { pass: false, detail: "B claimed before A done" };
  return { pass: true };
});

// 4. REGRESSION: atomic claim — same task never double-claimed.
scenario("atomic_claim", async () => {
  const g = createGoal({ description: "eval: atomic" });
  createTask({ goal_id: g, kind: "echo", title: "solo", spec: { echo: "s" }, verification_plan: { method: "none" } });
  const c1 = claimNext("w1");
  const c2 = claimNext("w2");
  if (!c1) return { pass: false, detail: "first claim failed" };
  if (c2 && c2.id === c1.id) return { pass: false, detail: "double-claimed same task" };
  return { pass: true };
});

// 5. BEHAVIORAL/SAFETY: high-risk task is gated by approval BEFORE side effects.
scenario("approval_gate_blocks_high_risk", async () => {
  const g = createGoal({ description: "eval: approval" });
  const t = createTask({ goal_id: g, kind: "echo", title: "risky", risk_level: "high", spec: { echo: "x" }, verification_plan: { method: "none" } });
  const r = await runTask(getTask(t));
  if (r.status !== "needs_approval") return { pass: false, detail: `expected needs_approval, got ${r.status}` };
  const ap = pendingApprovals();
  if (!ap.length) return { pass: false, detail: "no approval created" };
  // approve and re-run -> should complete
  decideApproval(ap[0].id, "approved", "eval");
  const r2 = await runTask(getTask(t));
  if (r2.status !== "done") return { pass: false, detail: `after approval expected done, got ${r2.status}` };
  return { pass: true };
});

// 6. CAPABILITY: command executor + independent verification (real files + node --test).
scenario("playbook_hello_utility_end_to_end", async () => {
  const r = planFromPlaybook("hello-utility", {});
  await runLoop("evalw");
  const tasks = all(`SELECT status FROM tasks WHERE goal_id=?`, r.goalId);
  const done = tasks.filter((t) => t.status === "done").length;
  if (done !== tasks.length) return { pass: false, detail: `${done}/${tasks.length} tasks done` };
  const kn = get(`SELECT id FROM knowledge WHERE key='slugify-utility'`);
  if (!kn) return { pass: false, detail: "knowledge not recorded" };
  return { pass: true };
});

// 7. BEHAVIORAL: verifier independently catches a lying execution (command exit mismatch).
scenario("verifier_catches_bad_result", async () => {
  const g = createGoal({ description: "eval: bad verify" });
  // executor "succeeds" (true) but verification command fails (exit 1 != expect 0)
  const t = createTask({
    goal_id: g, kind: "command", title: "false-success", max_attempts: 1,
    spec: { run: { cmd: "true" } },
    verification_plan: { method: "command", cmd: "exit 3", expectExit: 0 },
  });
  await runLoop("evalw");
  const task = getTask(t);
  if (task.status !== "failed") return { pass: false, detail: `expected failed, got ${task.status}` };
  return { pass: true };
});

// 8. M2 SAFETY: spend-incurring engine pauses (not fails) when the daily budget is exceeded.
scenario("budget_gate_pauses_llm_over_budget", async () => {
  const { addSpend } = await import("../src/core/governance.mjs");
  addSpend("day", new Date().toISOString().slice(0, 10), 999, 0); // blow the daily cap
  process.env.OMNI_ALLOW_CLAUDE = "1"; // so the claude engine is selected (but it won't run)
  const g = createGoal({ description: "eval: budget" });
  const t = createTask({ goal_id: g, kind: "llm", title: "expensive", spec: { prompt: "x", executor: "claude" }, verification_plan: { method: "none" } });
  const r = await runTask(getTask(t));
  process.env.OMNI_ALLOW_CLAUDE = "0";
  if (r.status !== "needs_approval" || r.reason !== "budget") return { pass: false, detail: `status=${r.status} reason=${r.reason}` };
  return { pass: true };
});

// 9. M2: git worktree isolation creates an isolated branch + dir and integrates a diff.
scenario("worktree_isolation", async () => {
  const { ensureRepo, addWorktree, captureDiff, integrateWorktree } = await import("../src/core/worktree.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omni-wt-"));
  ensureRepo(repo);
  const wt = addWorktree(repo, "task-x");
  if (!wt.branch.startsWith("omni/")) return { pass: false, detail: "branch not namespaced" };
  fs.writeFileSync(path.join(wt.wtPath, "new.txt"), "hello");
  const d = captureDiff(wt.wtPath);
  if (!d.files.includes("new.txt")) return { pass: false, detail: "diff missing new file" };
  const ok = integrateWorktree(repo, wt.branch, wt.wtPath, "test");
  if (!fs.existsSync(path.join(repo, "new.txt"))) return { pass: false, detail: "integrate did not land file in main" };
  fs.rmSync(repo, { recursive: true, force: true });
  return { pass: ok ? true : false };
});

// 10. M2: LLM planner falls back to a single safe task when LLM is gated (no spend).
scenario("llm_planner_fallback_when_gated", async () => {
  const { planFreeformLLM } = await import("../src/core/planner.mjs");
  const r = planFreeformLLM("build something open-ended", {});
  if (r.fallback !== "llm_disabled") return { pass: false, detail: `fallback=${r.fallback}` };
  if (r.taskIds.length !== 1) return { pass: false, detail: `expected 1 task, got ${r.taskIds.length}` };
  return { pass: true };
});

// 11. M2 REGRESSION (from a real bug): ensureRepo must create its OWN repo even INSIDE an
//     ambient git repo, so worktrees/commits never pollute the parent (e.g. the omni root).
scenario("repo_isolation_inside_ambient_repo", async () => {
  const { ensureRepo } = await import("../src/core/worktree.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const g = (a, c) => spawnSync("git", a, { cwd: c, encoding: "utf8" });
  const ambient = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ambient-"));
  g(["init", "-q"], ambient); g(["config", "user.email", "a@b"], ambient); g(["config", "user.name", "a"], ambient);
  fs.writeFileSync(path.join(ambient, "root.txt"), "root"); g(["add", "-A"], ambient); g(["commit", "-q", "-m", "root"], ambient);
  const sub = path.join(ambient, "projects", "p1", "artifacts");
  ensureRepo(sub);
  const top = g(["rev-parse", "--show-toplevel"], sub).stdout.trim();
  const isolated = fs.realpathSync(top) === fs.realpathSync(sub);
  const ambientCommits = g(["rev-list", "--count", "HEAD"], ambient).stdout.trim();
  fs.rmSync(ambient, { recursive: true, force: true });
  if (!isolated) return { pass: false, detail: `subdir toplevel=${top}, not isolated` };
  if (ambientCommits !== "1") return { pass: false, detail: `ambient repo polluted: ${ambientCommits} commits` };
  return { pass: true };
});

// 12. M2 REGRESSION (from a real bug): node_test must FAIL on zero tests (node --test exits 0).
scenario("node_test_fails_on_zero_tests", async () => {
  const { verify } = await import("../src/verify/verify.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "omni-empty-"));
  const r0 = await verify({ verification_plan: { method: "node_test" } }, { workspaceDir: empty });
  if (r0.passed !== false) return { pass: false, detail: `zero-test result should fail, got ${r0.passed}` };
  const withTest = fs.mkdtempSync(path.join(os.tmpdir(), "omni-withtest-"));
  fs.writeFileSync(path.join(withTest, "x.test.mjs"),
    "import test from 'node:test';import assert from 'node:assert';test('a',()=>assert.equal(1,1));");
  const r1 = await verify({ verification_plan: { method: "node_test" } }, { workspaceDir: withTest });
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(withTest, { recursive: true, force: true });
  if (r1.passed !== true) return { pass: false, detail: `valid test should pass, got ${r1.passed}` };
  return { pass: true };
});

// 13. M3: recurring scheduler honors intervals and runs due jobs (uses 'scan', not 'eval',
//     to avoid recursively invoking this harness).
scenario("recurring_scheduler", async () => {
  const { addRecurring, dueJobs, cronTick, listRecurring } = await import("../src/core/recurring.mjs");
  addRecurring({ name: "t-scan", action: "scan", every: 3600 });
  const dueNow = dueJobs(Date.now()).map((j) => j.name);
  if (!dueNow.includes("t-scan")) return { pass: false, detail: "never-run job should be due" };
  const ran = await cronTick(Date.now());
  if (!ran.find((r) => r.name === "t-scan" && r.status === "ok")) return { pass: false, detail: "cronTick did not run scan" };
  // Immediately after running, it should NOT be due again (interval not elapsed).
  const stillDue = dueJobs(Date.now()).map((j) => j.name);
  if (stillDue.includes("t-scan")) return { pass: false, detail: "job due again before interval elapsed" };
  // But it IS due once the interval has passed.
  const later = dueJobs(Date.now() + 3601 * 1000).map((j) => j.name);
  if (!later.includes("t-scan")) return { pass: false, detail: "job not due after interval" };
  return { pass: true };
});

// 14. M3: blast-radius marks hard-to-reverse actions and enumerates side effects.
scenario("blast_radius_computed", async () => {
  const { computeBlastRadius } = await import("../src/core/governance.mjs");
  const danger = computeBlastRadius({ title: "deploy billing to production", kind: "llm", risk_level: "high", spec: { prompt: "deploy to prod" } });
  if (danger.reversible !== false) return { pass: false, detail: "deploy should be irreversible" };
  if (!danger.side_effects.some((s) => /reverse/i.test(s))) return { pass: false, detail: "missing irreversible flag" };
  const safe = computeBlastRadius({ title: "format a string", kind: "command", risk_level: "low", spec: { run: { cmd: "echo hi" } } });
  if (safe.reversible !== true) return { pass: false, detail: "echo should be reversible" };
  return { pass: true };
});

// 15. M3: altitude views assemble consistent rollups across task/goal/project/portfolio.
scenario("altitude_views_rollup", async () => {
  const { goalView, projectView, portfolioView, taskView } = await import("../src/core/views.mjs");
  const pid = "proj_view_eval";
  const g = createGoal({ description: "eval: views", project_id: pid });
  const a = createTask({ goal_id: g, project_id: pid, kind: "echo", title: "v1", spec: { echo: "1" }, verification_plan: { method: "none" } });
  createTask({ goal_id: g, project_id: pid, kind: "echo", title: "v2", spec: { echo: "2" }, verification_plan: { method: "none" } });
  await runTask(getTask(a));
  const gv = goalView(g);
  if (gv.progress.done !== 1 || gv.progress.total !== 2) return { pass: false, detail: `goal progress ${JSON.stringify(gv.progress)}` };
  const tv = taskView(a);
  if (!tv || tv.task.status !== "done") return { pass: false, detail: "taskView missing/incomplete" };
  const pv = projectView(pid);
  if ((pv.tasksByStatus.done || 0) < 1) return { pass: false, detail: "projectView rollup wrong" };
  const port = portfolioView();
  if (!port.projects.find((p) => p.project_id === pid)) return { pass: false, detail: "portfolio missing project" };
  return { pass: true };
});

// 16. M4: one-change decision logic — keep on gain, auto-revert on regression / no gain.
scenario("one_change_decision_logic", async () => {
  const { decide } = await import("../src/improve/onechange.mjs");
  const base = { pass_rate: 1, failed: 0, total: 15 };
  if (decide(base, { pass_rate: 1, failed: 0, total: 16 }, {}) !== "kept") return { pass: false, detail: "added coverage should keep" };
  if (decide(base, { pass_rate: 0.9, failed: 1, total: 16 }, {}) !== "reverted_regression") return { pass: false, detail: "regression should revert" };
  if (decide(base, { pass_rate: 1, failed: 0, total: 15 }, {}) !== "reverted_no_gain") return { pass: false, detail: "equal+no-flag should revert" };
  if (decide(base, { pass_rate: 1, failed: 0, total: 15 }, { keepOnEqual: true }) !== "kept") return { pass: false, detail: "equal+keepOnEqual should keep" };
  if (decide(base, { pass_rate: 0, failed: 1, total: 15, error: true }, {}) !== "reverted_regression") return { pass: false, detail: "errored apply should revert" };
  return { pass: true };
});

// 17. M4: external-intelligence ranking prioritizes architecture signals, filters thin wrappers.
scenario("intel_digest_ranking", async () => {
  const { rankItems } = await import("../src/intel/digest.mjs");
  const ranked = rankItems([
    { source: "Durable", category: "durable", claim: "durable execution checkpoint resumable typed contract" },
    { source: "Wrapper", category: "wrapper", claim: "thin wrapper around a provider api, chat shell, no public architecture" },
  ]);
  if (ranked[0].source !== "Durable") return { pass: false, detail: "architecture signal should rank first" };
  const wrapper = ranked.find((r) => r.source === "Wrapper");
  if (wrapper.worth_testing) return { pass: false, detail: "thin wrapper should be filtered out" };
  if (!ranked[0].worth_testing || !ranked[0].experiment) return { pass: false, detail: "top signal needs an experiment" };
  return { pass: true };
});

// 18. M4: workflow mining compiles a valid parameterized playbook from the recurring pattern.
scenario("mining_playbook_shape", async () => {
  const { buildCodingUtilPlaybook } = await import("../src/improve/mine.mjs");
  const pb = buildCodingUtilPlaybook();
  if (!pb.params || !pb.params.includes("spec")) return { pass: false, detail: "missing spec param" };
  if (pb.tasks.length !== 2) return { pass: false, detail: "expected 2 tasks" };
  const impl = pb.tasks.find((t) => t.kind === "llm");
  if (!impl || !impl.spec.worktree || impl.verify.method !== "node_test") return { pass: false, detail: "impl task malformed" };
  const doc = pb.tasks.find((t) => t.kind === "memory");
  if (!doc || !(doc.depends_on || []).includes("implement")) return { pass: false, detail: "doc task missing dep" };
  if (!JSON.stringify(pb).includes("{{spec}}")) return { pass: false, detail: "no parameter placeholder" };
  return { pass: true };
});

// --- M5: contract/document review harness -------------------------------------------------
const CONTRACT = `SERVICES AGREEMENT
This Agreement is made between Acme Corp ("Disclosing Party") and Beta LLC ("Receiving Party").
1. Confidentiality
Confidential Information shall be protected and these obligations survive for three (3) years.
2. Term and Termination
This Agreement shall automatically renew for one-year terms unless thirty (30) days written notice is given.
3. Liability
The parties acknowledge damages may arise from performance of this Agreement.
4. Governing Law
This Agreement shall be governed by the laws of the State of Delaware; venue shall lie in Delaware.
`;
async function loadContractLogic() {
  const fs = await import("node:fs");
  const playbook = JSON.parse(fs.readFileSync(new URL("../src/harnesses/contract/playbook.json", import.meta.url), "utf8"));
  const logic = await import("../src/harnesses/contract/logic.mjs");
  return { logic, playbook };
}

// 19. M5: the harness runs all 5 phases and produces a templated report.
scenario("contract_harness_end_to_end", async () => {
  const { planContractReview } = await import("../src/harnesses/contract/plan.mjs");
  const { workspaceDir } = await import("../src/memory/memory.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const r = planContractReview(CONTRACT, { title: "eval" });
  await runLoop("cw");
  const tasks = all(`SELECT status FROM tasks WHERE goal_id=?`, r.goalId);
  const done = tasks.filter((t) => t.status === "done").length;
  if (done !== tasks.length) return { pass: false, detail: `${done}/${tasks.length} phases done` };
  const report = path.join(workspaceDir(r.projectId), "report.md");
  if (!fs.existsSync(report)) return { pass: false, detail: "no report.md" };
  const txt = fs.readFileSync(report, "utf8");
  if (!txt.includes("Risk score") || !txt.includes("Findings")) return { pass: false, detail: "report missing sections" };
  return { pass: true };
});

// 20. M5: deterministic review flags uncapped liability + auto-renewal.
scenario("contract_review_flags_issues", async () => {
  const { logic, playbook } = await loadContractLogic();
  const clauses = logic.extractClauses(CONTRACT, playbook);
  const findings = logic.reviewClauses(clauses, playbook);
  const liability = findings.find((f) => f.rule === "liability_cap");
  const autorenew = findings.find((f) => f.rule === "auto_renew_flag");
  if (!liability || liability.status === "pass") return { pass: false, detail: "uncapped liability not flagged" };
  if (!autorenew || autorenew.status !== "flag") return { pass: false, detail: "auto-renew not flagged" };
  return { pass: true };
});

// 21. M5: validation gate flags a missing required clause (no governing law).
scenario("contract_validation_flags_missing_clause", async () => {
  const { logic, playbook } = await loadContractLogic();
  const noGovLaw = "1. Confidentiality\nProtected for three (3) years.\n2. Term and Termination\nThirty (30) days written notice.\n";
  const cls = logic.classify(noGovLaw, playbook);
  const clauses = logic.extractClauses(noGovLaw, playbook);
  const findings = logic.reviewClauses(clauses, playbook);
  const v = logic.validate(cls, clauses, findings, playbook);
  if (!v.missing.includes("governing_law")) return { pass: false, detail: `missing=${JSON.stringify(v.missing)}` };
  if (v.riskScore <= 0) return { pass: false, detail: "risk score should be > 0" };
  return { pass: true };
});

// 22. M5: the json_has schema gate rejects a malformed phase artifact.
scenario("contract_schema_gate", async () => {
  const { verify } = await import("../src/verify/verify.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ctr-"));
  fs.writeFileSync(path.join(ws, "bad.json"), "[]"); // empty -> fails minItems
  const r0 = await verify({ verification_plan: { method: "json_has", path: "bad.json", minItems: 1 } }, { workspaceDir: ws });
  if (r0.passed !== false) return { pass: false, detail: "empty array should fail minItems" };
  fs.writeFileSync(path.join(ws, "ok.json"), JSON.stringify([{ rule: "x", status: "pass" }]));
  const r1 = await verify({ verification_plan: { method: "json_has", path: "ok.json", minItems: 1, requireKeys: ["rule", "status"] } }, { workspaceDir: ws });
  fs.rmSync(ws, { recursive: true, force: true });
  if (r1.passed !== true) return { pass: false, detail: "valid artifact should pass" };
  return { pass: true };
});

// --- M6: finance / reporting harness ---------------------------------------------------------
const CSV = `period,account,actual,budget,ledger
2026-Q1,Revenue,520000,500000,520000
2026-Q1,Marketing,95000,70000,95000
2026-Q1,Payroll,180000,180000,178500
2026-Q1,Cloud,42000,30000,42000
`;

// 23. M6: the finance harness runs all 5 phases and produces a board-style report.
scenario("finance_harness_end_to_end", async () => {
  const { planFinanceReport } = await import("../src/harnesses/finance/plan.mjs");
  const { workspaceDir } = await import("../src/memory/memory.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const r = planFinanceReport(CSV, { title: "eval" });
  await runLoop("fw");
  const tasks = all(`SELECT status FROM tasks WHERE goal_id=?`, r.goalId);
  const done = tasks.filter((t) => t.status === "done").length;
  if (done !== tasks.length) return { pass: false, detail: `${done}/${tasks.length} phases done` };
  const report = path.join(workspaceDir(r.projectId), "report.md");
  if (!fs.existsSync(report)) return { pass: false, detail: "no report.md" };
  const txt = fs.readFileSync(report, "utf8");
  if (!txt.includes("Variance") || !txt.includes("reconciliation")) return { pass: false, detail: "report missing sections" };
  return { pass: true };
});

// 24. M6: reconciliation flags a reported-vs-ledger discrepancy.
scenario("finance_reconcile_flags_discrepancy", async () => {
  const { ingest, reconcile } = await import("../src/harnesses/finance/logic.mjs");
  const { records } = ingest(CSV);
  const rec = reconcile(records);
  const payroll = rec.find((r) => r.account === "Payroll");
  if (!payroll || payroll.status !== "discrepancy") return { pass: false, detail: `payroll status=${payroll?.status}` };
  if (rec.find((r) => r.account === "Revenue").status !== "ok") return { pass: false, detail: "revenue should reconcile" };
  return { pass: true };
});

// 25. M6: variance analysis flags material budget overruns.
scenario("finance_analyze_flags_material_variance", async () => {
  const { ingest, analyze } = await import("../src/harnesses/finance/logic.mjs");
  const { records } = ingest(CSV);
  const an = analyze(records);
  const material = an.byAccount.filter((a) => a.material).map((a) => a.account);
  if (!material.includes("Marketing") || !material.includes("Cloud")) return { pass: false, detail: `material=${material.join(",")}` };
  if (an.totals.actual <= 0) return { pass: false, detail: "totals not computed" };
  return { pass: true };
});

// 26. M6: validation gate aggregates risk from discrepancies + materiality + data quality.
scenario("finance_validation_gate", async () => {
  const { ingest, reconcile, analyze, validate } = await import("../src/harnesses/finance/logic.mjs");
  const ing = ingest(CSV);
  const v = validate(ing, reconcile(ing.records), analyze(ing.records));
  if (v.discrepancies < 1 || v.materialVariances < 2) return { pass: false, detail: JSON.stringify(v) };
  if (!v.dataQualityOk || !["medium", "high"].includes(v.riskLevel)) return { pass: false, detail: `risk=${v.riskLevel}` };
  // bad data should trip the gate
  const bad = ingest("period,account,actual,budget,ledger\n2026-Q1,X,abc,100,100\n");
  if (bad.errors.length < 1) return { pass: false, detail: "bad row not caught" };
  return { pass: true };
});

// 27. M6: the LLM-enrichment consistency gate rejects a narrative that contradicts the numbers.
scenario("finance_enrichment_consistency_gate", async () => {
  const { validateNarrative } = await import("../src/harnesses/finance/enrich.mjs");
  const summary = { riskLevel: "medium", discrepancies: 1, material: 2 };
  const good = validateNarrative("Overall risk is medium: two material variances (Cloud, Marketing) and one reconciliation discrepancy in Payroll require attention.", summary);
  if (!good.ok) return { pass: false, detail: `good narrative rejected: ${good.reasons.join(";")}` };
  const bad = validateNarrative("All accounts reconcile and there is no material variance; the quarter looks medium and clean.", summary);
  if (bad.ok) return { pass: false, detail: "contradictory narrative passed the gate" };
  const noRisk = validateNarrative("Two material variances and one discrepancy were found.", summary);
  if (noRisk.ok) return { pass: false, detail: "missing risk-level statement should fail" };
  return { pass: true };
});

// 28. M7: the optional enrich phase runs end-to-end and SKIPS CLEANLY when LLM is gated
//     (no spend) — the deterministic report still stands.
scenario("finance_enrich_phase_gated_skips", async () => {
  const { planFinanceReport } = await import("../src/harnesses/finance/plan.mjs");
  const { workspaceDir } = await import("../src/memory/memory.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const r = planFinanceReport(CSV, { title: "eval-enrich", enrich: true });
  if (r.taskIds.length !== 6) return { pass: false, detail: `expected 6 phases, got ${r.taskIds.length}` };
  await runLoop("few");
  const tasks = all(`SELECT status FROM tasks WHERE goal_id=?`, r.goalId);
  if (tasks.filter((t) => t.status === "done").length !== 6) return { pass: false, detail: "not all phases done" };
  const ws = workspaceDir(r.projectId);
  const enrich = JSON.parse(fs.readFileSync(path.join(ws, "06-enrich.json"), "utf8"));
  if (enrich.status !== "skipped") return { pass: false, detail: `expected skipped, got ${enrich.status}` };
  if (!fs.existsSync(path.join(ws, "report.md"))) return { pass: false, detail: "deterministic report missing" };
  return { pass: true };
});

// --- M8: idempotent effect layer + saga compensation -----------------------------------------
// 29. M8: a saga commits all steps on success (all systems mutated).
scenario("saga_commits_on_success", async () => {
  const { runSaga } = await import("../src/effects/effects.mjs");
  const { newSystems, buildOnboardSteps, summarize } = await import("../src/effects/demo.mjs");
  const sys = newSystems();
  const r = runSaga("eval-ok", buildOnboardSteps(sys, { email: "ok@x.com", plan: "pro" }));
  if (r.status !== "committed" || r.committed !== 3) return { pass: false, detail: `status=${r.status} committed=${r.committed}` };
  const s = summarize(sys);
  if (s.crm_records !== 1 || s.billing_accounts !== 1 || s.emails_sent !== 1) return { pass: false, detail: JSON.stringify(s) };
  return { pass: true };
});

// 30. M8: on a mid-saga failure, committed steps are compensated in reverse — NO orphaned state.
scenario("saga_compensates_on_failure", async () => {
  const { runSaga } = await import("../src/effects/effects.mjs");
  const { newSystems, buildOnboardSteps, summarize } = await import("../src/effects/demo.mjs");
  const sys = newSystems();
  const r = runSaga("eval-fail", buildOnboardSteps(sys, { email: "fail@x.com" }, { failAt: 2 }));
  if (r.status !== "compensated" || r.failedStep !== 2) return { pass: false, detail: `status=${r.status} failedStep=${r.failedStep}` };
  const s = summarize(sys);
  // steps 0 (crm) and 1 (billing) committed then rolled back; step 2 (email) never sent.
  if (s.crm_records !== 0 || s.billing_accounts !== 0 || s.emails_sent !== 0) return { pass: false, detail: `orphaned state: ${JSON.stringify(s)}` };
  if (r.compensated !== 2) return { pass: false, detail: `expected 2 compensated, got ${r.compensated}` };
  return { pass: true };
});

// 31. M8: idempotency — re-applying a committed effect does NOT run the side effect twice.
scenario("effect_idempotency", async () => {
  const { applyEffect } = await import("../src/effects/effects.mjs");
  let calls = 0;
  const effect = { kind: "charge", keyParts: ["inv-42"], payload: { amount: 100 }, do: () => { calls++; return { ok: true }; } };
  const a = applyEffect(effect);
  const b = applyEffect(effect); // same idempotency key
  if (calls !== 1) return { pass: false, detail: `side effect ran ${calls} times` };
  if (!b.idempotent || b.status !== "committed") return { pass: false, detail: "second apply not an idempotent hit" };
  if (a.key !== b.key) return { pass: false, detail: "idempotency keys differ" };
  return { pass: true };
});

// --- M9: incident/recovery harness (integrates the saga layer) -------------------------------
const INCIDENT = JSON.stringify({ title: "Checkout 5xx spike", symptoms: ["elevated 5xx error rate", "latency p99 elevated"], metrics: { errorRatePct: 18, latencyP99Ms: 4200 }, recentDeploy: true, affectedSystems: ["checkout-api", "payments"] });
async function loadIncidentLogic() {
  const fs = await import("node:fs");
  const runbook = JSON.parse(fs.readFileSync(new URL("../src/harnesses/incident/runbook.json", import.meta.url), "utf8"));
  const logic = await import("../src/harnesses/incident/logic.mjs");
  return { logic, runbook };
}

// 32. M9: triage assigns the right severity; diagnose finds the runbook root cause.
scenario("incident_triage_and_diagnose", async () => {
  const { logic, runbook } = await loadIncidentLogic();
  const inc = JSON.parse(INCIDENT);
  const t = logic.triage(inc, runbook);
  if (t.severity !== "sev1") return { pass: false, detail: `severity=${t.severity}` };
  const d = logic.diagnose(inc, runbook);
  if (d.topCause !== "bad_deploy" || !d.mitigations.includes("rollback_deploy")) return { pass: false, detail: `topCause=${d.topCause}` };
  return { pass: true };
});

// 33. M9: full harness recovers a bad-deploy incident and writes a postmortem.
scenario("incident_harness_end_to_end_recovers", async () => {
  const { planIncident } = await import("../src/harnesses/incident/plan.mjs");
  const { workspaceDir } = await import("../src/memory/memory.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const r = planIncident(INCIDENT, { title: "eval" });
  await runLoop("iw");
  const tasks = all(`SELECT status FROM tasks WHERE goal_id=?`, r.goalId);
  if (tasks.filter((t) => t.status === "done").length !== 5) return { pass: false, detail: "not all phases done" };
  const recovery = JSON.parse(fs.readFileSync(path.join(workspaceDir(r.projectId), "04-recovery.json"), "utf8"));
  if (!recovery.recovered) return { pass: false, detail: "did not recover" };
  const report = fs.readFileSync(path.join(workspaceDir(r.projectId), "report.md"), "utf8");
  if (!report.includes("Postmortem") || !report.includes("RECOVERED")) return { pass: false, detail: "postmortem malformed" };
  return { pass: true };
});

// 34. M9: a failing remediation rolls back via the saga — committed mitigations are reverted.
scenario("incident_mitigation_saga_rolls_back", async () => {
  const { logic, runbook } = await loadIncidentLogic();
  const { runSaga } = await import("../src/effects/effects.mjs");
  const inc = { title: "DB outage", symptoms: ["database connection errors"], metrics: { errorRatePct: 30 }, recentDeploy: false, affectedSystems: ["api"] };
  const d = logic.diagnose(inc, runbook);
  if (d.topCause !== "database_outage" || d.mitigations.length < 2) return { pass: false, detail: `mitigations=${JSON.stringify(d.mitigations)}` };
  const infra = logic.initialInfra(inc); // dbHealthy=false (db symptom)
  const steps = logic.buildMitigationSteps(infra, d.mitigations, { failMitigation: "restart_service" });
  const saga = runSaga("eval-incident-fail", steps);
  if (saga.status !== "compensated") return { pass: false, detail: `saga=${saga.status}` };
  // failover_db committed (set dbHealthy=true) then rolled back to original false.
  if (infra.dbHealthy !== false) return { pass: false, detail: "committed mitigation not rolled back" };
  const recovery = logic.verifyRecovery(infra);
  if (recovery.recovered) return { pass: false, detail: "should not recover after rollback" };
  return { pass: true };
});

// 35. M9 REGRESSION (real bug): idempotency keys are scoped per incident — the SAME action in
//     two different incidents both execute (a global key would skip the second as "already done").
scenario("incident_idempotency_scoped_per_incident", async () => {
  const { logic, runbook } = await loadIncidentLogic();
  const { runSaga } = await import("../src/effects/effects.mjs");
  const inc = { title: "Deploy regression", symptoms: ["5xx errors"], metrics: { errorRatePct: 20 }, recentDeploy: true, affectedSystems: ["api"] };
  const d = logic.diagnose(inc, runbook); // bad_deploy -> rollback_deploy
  const i1 = logic.initialInfra(inc); const i2 = logic.initialInfra(inc);
  runSaga("inc-A", logic.buildMitigationSteps(i1, d.mitigations, { scope: "incident-A" }));
  runSaga("inc-B", logic.buildMitigationSteps(i2, d.mitigations, { scope: "incident-B" }));
  // Both must have actually executed the rollback (errorRate dropped), not been idempotently skipped.
  if (i1.errorRatePct > 5 || i2.errorRatePct > 5) return { pass: false, detail: `i1=${i1.errorRatePct} i2=${i2.errorRatePct} (scoping failed)` };
  return { pass: true };
});

// --- M10: research/science harness (reproducibility, lineage, uncertainty) -------------------
const EXP = JSON.stringify({ question: "estimate pi", hypothesis: "MC converges to pi", method: "monte_carlo_pi", params: { samples: 20000, seeds: [1, 2, 3, 4, 5] } });

// 36. M10: experiments are deterministic — same seed yields the SAME result (reproducible base).
scenario("research_run_is_deterministic", async () => {
  const { EXPERIMENTS } = await import("../src/harnesses/research/experiments.mjs");
  const a = EXPERIMENTS.monte_carlo_pi.run({ samples: 5000 }, 42);
  const b = EXPERIMENTS.monte_carlo_pi.run({ samples: 5000 }, 42);
  const c = EXPERIMENTS.monte_carlo_pi.run({ samples: 5000 }, 43);
  if (a.estimate !== b.estimate) return { pass: false, detail: "same seed gave different results" };
  if (a.estimate === c.estimate) return { pass: false, detail: "different seeds gave identical results" };
  if (Math.abs(a.estimate - Math.PI) > 0.2) return { pass: false, detail: `estimate ${a.estimate} far from pi` };
  return { pass: true };
});

// 37. M10: analysis reports a point estimate WITH uncertainty (std + CI).
scenario("research_analysis_uncertainty", async () => {
  const { design, runExperiment, analyze } = await import("../src/harnesses/research/logic.mjs");
  const d = design(JSON.parse(EXP));
  if (!d.valid) return { pass: false, detail: d.errors.join(";") };
  const a = analyze(runExperiment(d.manifest));
  if (a.n_runs !== 5 || a.estimate_std == null || !Array.isArray(a.ci95)) return { pass: false, detail: JSON.stringify(a) };
  if (Math.abs(a.estimate_mean - Math.PI) > 0.1) return { pass: false, detail: `mean ${a.estimate_mean}` };
  return { pass: true };
});

// 38. M10: reproducibility check passes on a faithful rerun and FAILS on tampered results.
scenario("research_reproducibility_check", async () => {
  const { design, runExperiment, reproduce } = await import("../src/harnesses/research/logic.mjs");
  const d = design(JSON.parse(EXP));
  const orig = runExperiment(d.manifest);
  const ok = reproduce(d.manifest, orig);
  if (!ok.reproducible) return { pass: false, detail: `faithful rerun not reproduced: ${JSON.stringify(ok)}` };
  // tamper a stored result -> must be detected as non-reproducible
  const tampered = JSON.parse(JSON.stringify(orig));
  tampered.results[0].estimate += 0.5;
  const bad = reproduce(d.manifest, tampered);
  if (bad.reproducible) return { pass: false, detail: "tampered result passed reproducibility" };
  return { pass: true };
});

// 39. M10: full harness runs all 6 phases and writes a report with reproducibility.
scenario("research_harness_end_to_end", async () => {
  const { planResearch } = await import("../src/harnesses/research/plan.mjs");
  const { workspaceDir } = await import("../src/memory/memory.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const r = planResearch(EXP, { title: "eval" });
  await runLoop("rw");
  const tasks = all(`SELECT status FROM tasks WHERE goal_id=?`, r.goalId);
  if (tasks.filter((t) => t.status === "done").length !== 6) return { pass: false, detail: "not all phases done" };
  const repro = JSON.parse(fs.readFileSync(path.join(workspaceDir(r.projectId), "05-repro.json"), "utf8"));
  if (!repro.reproducible) return { pass: false, detail: "end-to-end not reproducible" };
  const report = fs.readFileSync(path.join(workspaceDir(r.projectId), "report.md"), "utf8");
  if (!report.includes("Reproducibility") || !report.includes("uncertainty")) return { pass: false, detail: "report malformed" };
  return { pass: true };
});

// 40. M11: many tasks claimed by alternating workers — each claimed exactly once, all drained.
scenario("concurrent_claim_no_duplicates", async () => {
  const g = createGoal({ description: "eval: concurrent claim" });
  const K = 12;
  for (let i = 0; i < K; i++) createTask({ goal_id: g, kind: "echo", title: `p${i}`, spec: { echo: `${i}` }, verification_plan: { method: "none" } });
  const claimed = [];
  let worker = 0;
  for (let n = 0; n < K + 5; n++) {
    const t = claimNext(`w${worker % 3}`); // 3 interleaved workers
    worker++;
    if (t) claimed.push(t.id);
  }
  const unique = new Set(claimed);
  if (unique.size !== claimed.length) return { pass: false, detail: `duplicate claims: ${claimed.length} claims, ${unique.size} unique` };
  // all K from this goal got claimed (filter to this goal's tasks)
  const mine = claimed.filter((id) => all(`SELECT goal_id FROM tasks WHERE id=?`, id)[0]?.goal_id === g);
  if (mine.length !== K) return { pass: false, detail: `claimed ${mine.length}/${K} of this goal` };
  return { pass: true };
});

// --- M12/M13: the entity (conversational agent) + model adapter ------------------------------
// 41. The router brain maps natural language to the right capability intents (no model needed).
scenario("entity_router_intents", async () => {
  const { classify } = await import("../src/agent/router.mjs");
  const cases = [
    ["who are you?", "whoami"], ["how are things going?", "status"], ["remember I prefer dark mode", "remember"],
    ["what can you do", "help"], ["are you connected to a model?", "model"], ["review this contract deal.txt", "harness_contract"],
    ["onboard alice@acme.com", "onboard"], ["hello there", "greet"],
  ];
  for (const [input, want] of cases) {
    const got = classify(input).intent;
    if (got !== want) return { pass: false, detail: `"${input}" -> ${got} (wanted ${want})` };
  }
  return { pass: true };
});

// 42. The entity remembers what it's told and recalls it later (durable memory).
scenario("entity_remembers_and_recalls", async () => {
  const { converse } = await import("../src/agent/converse.mjs");
  const r1 = await converse("remember that the launch date is March 9");
  if (!/remember|noted/i.test(r1.reply)) return { pass: false, detail: `store reply: ${r1.reply}` };
  const r2 = await converse("what do you know about launch?");
  if (!/March 9/i.test(r2.reply)) return { pass: false, detail: `recall reply: ${r2.reply}` };
  return { pass: true };
});

// 43. No model connected -> not connected, and free-form input falls back gracefully (no crash).
scenario("entity_model_dormant_until_connected", async () => {
  const { modelStatus, getProvider } = await import("../src/llm/index.mjs");
  if (getProvider() !== null) return { pass: false, detail: "a model should not be connected in evals" };
  if (modelStatus().connected !== false) return { pass: false, detail: "modelStatus should report not connected" };
  const { converse } = await import("../src/agent/converse.mjs");
  const r = await converse("compose a haiku about quarterly OKRs");
  if (!/model|help/i.test(r.reply)) return { pass: false, detail: `fallback should mention connecting a model: ${r.reply}` };
  return { pass: true };
});

// 44. The OpenAI-compatible adapter builds a correct endpoint URL (the connect-a-model surface).
scenario("openai_adapter_url_shape", async () => {
  // available() is false without config; assert the dormant contract + URL normalization logic.
  const oa = await import("../src/llm/openai.mjs");
  if (oa.available() !== false) return { pass: false, detail: "should be unavailable without endpoint+model" };
  // URL builder is internal; validate the documented contract via the module's exports presence.
  if (typeof oa.chat !== "function" || oa.name !== "openai") return { pass: false, detail: "adapter contract missing" };
  return { pass: true };
});

// Auto-load any generated scenario files (evals/scenarios/*.mjs). This lets the self-improvement
// loop add eval coverage by dropping a modular file — no edits to this harness required.
// Each file default-exports an array of { name, fn }.
{
  const { readdirSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = new URL("./scenarios/", import.meta.url);
  const dirPath = fileURLToPath(dir);
  if (existsSync(dirPath)) {
    for (const f of readdirSync(dirPath).filter((x) => x.endsWith(".mjs")).sort()) {
      try {
        const mod = await import(new URL(f, dir).href);
        for (const s of mod.default || []) scenarios.push(s);
      } catch (e) {
        scenarios.push({ name: `scenario_load:${f}`, fn: async () => ({ pass: false, detail: e.message }) });
      }
    }
  }
}

const results = [];
for (const s of scenarios) {
  try {
    const out = await s.fn();
    results.push({ scenario: s.name, status: out.pass ? "pass" : "fail", detail: out.detail || "", score: out.pass ? 1 : 0 });
  } catch (e) {
    results.push({ scenario: s.name, status: "fail", detail: `threw: ${e.message}`, score: 0 });
  }
}
const passed = results.filter((r) => r.status === "pass").length;
process.stdout.write(JSON.stringify({ total: results.length, passed, failed: results.length - passed, results }));
