#!/usr/bin/env node
// omni — operator CLI. The universal entrypoint over goals, tasks, execution, verification,
// memory, governance, evals, and the control plane.
import "../src/quiet.mjs";
import fs from "node:fs";
import { ensureDirs, POLICY, PATHS } from "../src/config.mjs";
import { db } from "../src/db.mjs";
import { log } from "../src/log.mjs";

const BOOLEAN_FLAGS = new Set(["single", "enrich", "bad"]); // flags that never consume the next token
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);

async function main() {
  switch (cmd) {
    case "init": {
      ensureDirs();
      db(); // create schema
      const { ensureBaselineQueues } = await import("../src/core/queues.mjs");
      ensureBaselineQueues();
      const { ensureIdentity } = await import("../src/agent/identity.mjs");
      const { ensureRecurringDefaults } = await import("../src/core/recurring.mjs");
      const ent = ensureIdentity();
      ensureRecurringDefaults();
      log.ok(`omni initialized — entity "${ent.name}" is awake.`);
      log.dim(`  db:        ${PATHS.db}`);
      log.dim(`  projects:  ${PATHS.projects}`);
      log.dim(`  playbooks: ${PATHS.playbooks}`);
      log.dim(`  claude executor: ${POLICY.allowClaude ? "ENABLED" : "gated (set OMNI_ALLOW_CLAUDE=1)"}`);
      break;
    }

    case "goal": {
      ensureDirs(); db();
      const desc = positional.join(" ");
      if (flags.playbook) {
        const { planFromPlaybook } = await import("../src/core/planner.mjs");
        const params = {};
        if (flags.spec) params.spec = flags.spec;
        if (flags.param && flags.param.includes("=")) { const [k, ...v] = flags.param.split("="); params[k] = v.join("="); }
        const r = planFromPlaybook(flags.playbook, { params });
        log.ok(`Goal ${r.goalId} planned from playbook '${flags.playbook}' (${r.taskIds.length} tasks).`);
        log.dim(`  project: ${r.projectId}`);
        log.dim(`  run it:  node bin/omni.mjs run`);
      } else {
        if (!desc) { log.err("Provide a goal description or --playbook <name>."); process.exit(1); }
        const planner = await import("../src/core/planner.mjs");
        const r = flags.single
          ? planner.planFreeform(desc, { mode: flags.mode, risk: flags.risk })
          : planner.planFreeformLLM(desc, { mode: flags.mode });
        log.ok(`Freeform goal ${r.goalId} planned (${r.taskIds.length} task${r.taskIds.length === 1 ? "" : "s"}, project ${r.projectId}).`);
        if (r.fallback) log.warn(`LLM planner fell back (${r.fallback}). Enable with OMNI_ALLOW_CLAUDE=1 for decomposition.`);
        else if (r.planCost) log.dim(`  planning cost: $${r.planCost.toFixed(4)}`);
        if (!POLICY.allowClaude) log.warn("LLM execution is gated. Enable with OMNI_ALLOW_CLAUDE=1 to run it.");
      }
      const { syncQueues } = await import("../src/core/queues.mjs");
      syncQueues();
      break;
    }

    case "playbooks": {
      const { listPlaybooks } = await import("../src/core/planner.mjs");
      const pbs = listPlaybooks();
      log.head("Available playbooks");
      for (const p of pbs) log.info(p);
      if (!pbs.length) log.dim("  (none — add JSON files under playbooks/)");
      break;
    }

    case "run": {
      ensureDirs(); db();
      const W = Number(flags.workers || 1);
      if (W > 1) {
        // Controlled parallelism: N concurrent worker PROCESSES drain the shared WAL queue.
        // Atomic leased claiming guarantees each task runs exactly once.
        const { spawn } = await import("node:child_process");
        const { all } = await import("../src/db.mjs");
        log.step(`Running ${W} parallel worker processes ...`);
        const t0 = Date.now();
        await Promise.all(Array.from({ length: W }, (_, i) => new Promise((res) => {
          const c = spawn("node", [process.argv[1], "run", "--worker", `w${i}`], { stdio: "ignore" });
          c.on("exit", res);
        })));
        const ms = Date.now() - t0;
        const dupes = all(`SELECT task_id, COUNT(*) n FROM sessions GROUP BY task_id HAVING n > 1`);
        log.ok(`Parallel drain done in ${ms}ms across ${W} workers`);
        log[dupes.length ? "err" : "ok"](`Double-execution check: ${dupes.length === 0 ? "PASS (every task ran exactly once)" : "FAIL — " + dupes.length + " task(s) ran twice"}`);
        break;
      }
      const { runLoop } = await import("../src/worker/worker.mjs");
      const worker = flags.worker || "worker-1";
      const results = await runLoop(worker, { maxTicks: Number(flags.maxTicks || 500) });
      const counts = {};
      for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
      if (!flags.worker) log.ok(`Loop drained: ${results.length} task-runs  ${JSON.stringify(counts)}`);
      break;
    }

    case "demo-parallel": {
      ensureDirs(); db();
      const { createGoal } = await import("../src/core/goals.mjs");
      const { createTask } = await import("../src/core/tasks.mjs");
      const { ensureProject } = await import("../src/memory/memory.mjs");
      const count = Number(flags.count || 8);
      const slp = flags.sleep || "0.3";
      const pid = `proj_parallel_${Date.now().toString(36).slice(-6)}`;
      ensureProject(pid, { title: "Parallel demo" });
      const goalId = createGoal({ project_id: pid, description: `parallel demo (${count} independent tasks)` });
      for (let i = 0; i < count; i++) {
        createTask({
          goal_id: goalId, project_id: pid, kind: "command", title: `parallel task ${i}`,
          spec: { run: { cmd: `sleep ${slp}; echo done > out-${i}.txt` } },
          verification_plan: { method: "file_exists", paths: [`out-${i}.txt`] },
        });
      }
      log.ok(`Created ${count} independent tasks (~${slp}s each) in goal ${goalId}.`);
      log.dim(`  drain in parallel:  node bin/omni.mjs run --workers 4`);
      break;
    }

    case "tick": {
      ensureDirs(); db();
      const { tick } = await import("../src/worker/worker.mjs");
      const r = await tick(flags.worker || "worker-1");
      log.info(JSON.stringify(r.idle ? { idle: true } : { task: r.taskId, status: r.status }));
      break;
    }

    case "status": {
      ensureDirs(); db();
      const { printStatus } = await import("../src/status.mjs");
      console.log(printStatus());
      break;
    }

    case "queues": {
      ensureDirs(); db();
      const q = await import("../src/core/queues.mjs");
      if (positional[0] === "add" && positional.length >= 3) {
        const queue = positional[1];
        const title = positional.slice(2).join(" ");
        q.addQueueItem(queue, { title, note: flags.note });
        q.writeMirror();
        log.ok(`Added to ${queue}: ${title}`);
      } else {
        q.syncQueues();
        const all = q.allQueues();
        for (const name of q.QUEUES) {
          log.head(name);
          for (const it of all[name]) log.info(`${it.title}${it.note ? "  — " + it.note : ""}`);
          if (!all[name].length) log.dim("  (empty)");
        }
      }
      break;
    }

    case "approvals": {
      ensureDirs(); db();
      const { pendingApprovals } = await import("../src/core/governance.mjs");
      const ps = pendingApprovals();
      log.head("Pending approvals");
      for (const a of ps) log.info(`${a.id}  risk=${a.risk}  ${a.action}`);
      if (!ps.length) log.dim("  (none)");
      break;
    }

    case "approve":
    case "deny": {
      ensureDirs(); db();
      const { decideApproval } = await import("../src/core/governance.mjs");
      const aid = positional[0];
      if (!aid) { log.err("Usage: omni " + cmd + " <approvalId>"); process.exit(1); }
      decideApproval(aid, cmd === "approve" ? "approved" : "denied", flags.by || "operator");
      log.ok(`Approval ${aid} ${cmd === "approve" ? "approved" : "denied"}.`);
      break;
    }

    case "trust": {
      ensureDirs(); db();
      const { listTrust } = await import("../src/core/governance.mjs");
      log.head("Trust (per domain)");
      for (const t of listTrust()) log.info(`${t.domain.padEnd(12)} ${t.level.padEnd(11)} ✓${t.successes} ✗${t.failures}`);
      break;
    }

    case "knowledge": {
      ensureDirs(); db();
      const { searchKnowledge } = await import("../src/memory/memory.mjs");
      const rows = searchKnowledge(positional.join(" ") || "");
      log.head("Knowledge");
      for (const k of rows) log.info(`[${k.kind}] ${k.key}: ${(k.value || "").slice(0, 80)}`);
      if (!rows.length) log.dim("  (none)");
      break;
    }

    case "say":
    case "ask": {
      ensureDirs(); db();
      const { converse } = await import("../src/agent/converse.mjs");
      const input = positional.join(" ");
      if (!input) { log.err('Usage: omni say "<message>"'); process.exit(1); }
      const r = await converse(input);
      console.log("\n" + r.reply + "\n");
      log.dim(`  (${r.intent} · ${r.via})`);
      break;
    }

    case "chat":
    case "console":
    case "repl": {
      ensureDirs(); db();
      const { startConsole } = await import("../src/agent/console.mjs");
      await startConsole();
      return; // console owns the process lifecycle
    }

    case "whoami-entity":
    case "identity": {
      ensureDirs(); db();
      const { getIdentity } = await import("../src/agent/identity.mjs");
      const { modelStatus } = await import("../src/llm/index.mjs");
      const id = getIdentity();
      log.head(id.name);
      log.info(id.persona);
      log.dim(`  born ${id.born} · v${id.version} · brain: ${modelStatus().connected ? "model" : "deterministic"}`);
      for (const n of id.selfNotes.slice(0, 5)) log.dim(`  · ${n.at.slice(0, 10)} ${n.note}`);
      break;
    }

    case "model": {
      ensureDirs();
      const { modelStatus } = await import("../src/llm/index.mjs");
      const m = modelStatus();
      log.head("Brain / model status");
      if (m.connected) { log.ok(`connected via ${m.provider}${m.model ? " (" + m.model + ")" : ""}${m.endpoint ? " @ " + m.endpoint : ""}`); }
      else {
        log.warn("no model connected — running on the deterministic router brain");
        log.dim("  " + m.hint);
        log.dim("  example: OMNI_LLM_ENDPOINT=http://localhost:11434/v1 OMNI_LLM_MODEL=llama3.1 omni chat");
      }
      break;
    }

    case "saga": {
      ensureDirs(); db();
      const { runSaga, listSagas } = await import("../src/effects/effects.mjs");
      const { buildOnboardSteps, loadSystems, saveSystems, summarize } = await import("../src/effects/demo.mjs");
      if (positional[0] === "onboard") {
        const email = positional[1] || "new.customer@example.com";
        const systems = loadSystems();
        const before = summarize(systems);
        const failAtRaw = flags["fail-at"] ?? flags.failat;
        const steps = buildOnboardSteps(systems, { email, plan: flags.plan || "pro" }, { failAt: failAtRaw != null ? Number(failAtRaw) : undefined });
        const r = runSaga(`onboard:${email}`, steps);
        saveSystems(systems);
        log[r.status === "committed" ? "ok" : "warn"](`Saga ${r.status}` + (r.failedStep != null ? ` (failed at step ${r.failedStep}: ${r.error}; rolled back ${r.compensated})` : ` (${r.committed} steps)`));
        log.dim(`  systems before: ${JSON.stringify(before)}`);
        log.dim(`  systems after:  ${JSON.stringify(summarize(systems))}  ${r.status === "compensated" ? "← no orphaned state" : ""}`);
      } else {
        log.head("Recent sagas");
        for (const s of listSagas()) log.info(`${s.ts.slice(0, 19)}  ${s.status.padEnd(12)} ${s.name}  (committed ${s.committed}, compensated ${s.compensated})`);
      }
      break;
    }

    case "effects": {
      ensureDirs(); db();
      const { listEffects } = await import("../src/effects/effects.mjs");
      log.head("Effects (idempotent side-effect ledger)");
      for (const e of listEffects(positional[0])) log.info(`${(e.ts || "").slice(11, 19)}  ${e.status.padEnd(11)} ${e.kind.padEnd(16)} step ${e.step}`);
      break;
    }

    case "harness": {
      ensureDirs(); db();
      const which = positional[0];
      const HARNESSES = {
        contract: { mod: "../src/harnesses/contract/plan.mjs", fn: "planContractReview", label: "contract/document review", input: "<file.txt>" },
        finance: { mod: "../src/harnesses/finance/plan.mjs", fn: "planFinanceReport", label: "finance variance + reconciliation", input: "<file.csv>" },
        incident: { mod: "../src/harnesses/incident/plan.mjs", fn: "planIncident", label: "incident triage + saga-backed recovery", input: "<file.json>" },
        research: { mod: "../src/harnesses/research/plan.mjs", fn: "planResearch", label: "experiment w/ reproducibility + uncertainty", input: "<file.json>" },
      };
      const h = HARNESSES[which];
      if (h) {
        const file = positional[1];
        if (!file || !fs.existsSync(file)) { log.err(`Usage: omni harness ${which} ${h.input}`); process.exit(1); }
        const text = fs.readFileSync(file, "utf8");
        const mod = await import(h.mod);
        const { runLoop } = await import("../src/worker/worker.mjs");
        const { syncQueues } = await import("../src/core/queues.mjs");
        const r = mod[h.fn](text, { title: `${which}: ${file.split("/").pop()}`, enrich: !!flags.enrich, failMitigation: flags["fail-mitigation"] });
        log.step(`${which} harness planned (${r.taskIds.length} phases). Running...`);
        const results = await runLoop("harness-worker");
        syncQueues();
        const counts = {};
        for (const x of results) counts[x.status] = (counts[x.status] || 0) + 1;
        log.ok(`Harness complete: ${JSON.stringify(counts)}`);
        const reportPath = `projects/${r.projectId}/artifacts/report.md`;
        if (fs.existsSync(reportPath)) {
          log.dim(`  report: ${reportPath}`);
          console.log("\n" + fs.readFileSync(reportPath, "utf8"));
        }
      } else {
        log.head("Specialized harnesses");
        for (const [k, v] of Object.entries(HARNESSES)) log.info(`${k.padEnd(9)} — ${v.label}  (usage: omni harness ${k} ${v.input})`);
      }
      break;
    }

    case "mine": {
      ensureDirs(); db();
      const { detectCodingUtilPattern, codingUtilCandidate } = await import("../src/improve/mine.mjs");
      const { runOneChange } = await import("../src/improve/onechange.mjs");
      const pat = detectCodingUtilPattern();
      log.info(`pattern 'coding-util' recurred ${pat.count}x: ${pat.examples.join(", ")}`);
      if (!pat.recurred) { log.warn("Not enough repetition yet to mine (need >=2)."); break; }
      log.step("Mining -> compiling a parameterized playbook + eval, guarded by the one-change loop...");
      const r = await runOneChange(codingUtilCandidate());
      log[r.decision === "kept" ? "ok" : "warn"](`Decision: ${r.decision} (evals ${r.baseline.passed}/${r.baseline.total} -> ${r.after.passed}/${r.after.total})`);
      break;
    }

    case "improve": {
      ensureDirs(); db();
      const { runOneChange } = await import("../src/improve/onechange.mjs");
      const mine = await import("../src/improve/mine.mjs");
      const candidate = flags.bad ? mine.brokenDemoCandidate() : mine.codingUtilCandidate();
      log.step(`One-change loop: ${candidate.name} (${flags.bad ? "DEMO bad change to prove auto-revert" : "improvement"})`);
      const r = await runOneChange(candidate);
      log[r.decision === "kept" ? "ok" : "warn"](`Decision: ${r.decision}`);
      log.dim(`  baseline ${r.baseline.passed}/${r.baseline.total} -> after ${r.after.passed}/${r.after.total}${r.error ? " · error: " + r.error : ""}`);
      break;
    }

    case "intel": {
      ensureDirs(); db();
      const { runDigest } = await import("../src/intel/digest.mjs");
      const d = runDigest();
      log.ok(`Intel digest: ${d.worth_testing}/${d.total} signals worth testing`);
      for (const r of d.ranked) log.dim(`  ${r.worth_testing ? "✓" : "·"} [${String(r.score).padStart(2)}] ${r.source} (${r.category})`);
      break;
    }

    case "improvements": {
      ensureDirs(); db();
      const { all } = await import("../src/db.mjs");
      log.head("Improvement ledger");
      for (const i of all(`SELECT name,decision,baseline_pass,after_pass,ts FROM improvements ORDER BY ts DESC LIMIT 20`))
        log.info(`${i.ts.slice(0, 19)}  ${i.decision.padEnd(20)} ${i.name}  (${Math.round(i.baseline_pass * 100)}%->${Math.round(i.after_pass * 100)}%)`);
      break;
    }

    case "eval": {
      ensureDirs(); db();
      const { runEvals } = await import("../evals/run-evals.mjs");
      const r = await runEvals();
      log[r.failed ? "warn" : "ok"](`Evals: ${r.passed}/${r.total} passed (${(r.pass_rate * 100).toFixed(0)}%)`);
      for (const e of r.results) log.dim(`  ${e.status === "pass" ? "✓" : "✗"} ${e.scenario}${e.detail ? " — " + e.detail : ""}`);
      if (r.failed) process.exit(1);
      break;
    }

    case "serve": {
      ensureDirs(); db();
      const { startServer } = await import("../src/control-plane/server.mjs");
      startServer(Number(flags.port || POLICY.serverPort));
      break;
    }

    case "recurring": {
      ensureDirs(); db();
      const rec = await import("../src/core/recurring.mjs");
      if (positional[0] === "add" && flags.name && flags.action) {
        rec.addRecurring({ name: flags.name, action: flags.action, every: flags.every || "daily" });
        log.ok(`Recurring '${flags.name}' -> ${flags.action} every ${flags.every || "daily"}`);
      } else {
        if (positional[0] === "seed") rec.ensureRecurringDefaults();
        log.head("Recurring operations");
        for (const j of rec.listRecurring())
          log.info(`${j.name.padEnd(16)} ${j.action.padEnd(8)} every ${j.interval_sec}s  last:${j.last_run || "never"} (${j.runs} runs)`);
      }
      break;
    }

    case "cron-tick": {
      ensureDirs(); db();
      const { cronTick, ensureRecurringDefaults } = await import("../src/core/recurring.mjs");
      ensureRecurringDefaults();
      const ran = await cronTick();
      log.ok(`cron-tick: ran ${ran.length} due job(s)`);
      for (const r of ran) log.dim(`  ${r.status === "ok" ? "✓" : "✗"} ${r.name} — ${JSON.stringify(r.summary)}`);
      break;
    }

    case "scan": {
      ensureDirs(); db();
      const { proactiveScan } = await import("../src/improve/scan.mjs");
      const found = proactiveScan();
      log.ok(`Proactive scan created ${found.length} momentum item(s).`);
      for (const f of found) log.dim(`  · ${f}`);
      break;
    }

    default:
      console.log(`omni — agentic operating system

Usage: node bin/omni.mjs <command> [args]

  chat                         talk to the entity (interactive)
  say "<message>"              one-shot message to the entity
  identity | model             the entity's self / brain (model) status
  init                         create state, schema, baseline queues
  goal "<desc>" [--playbook X] create a goal (freeform or from a playbook)
  playbooks                    list available playbooks
  run [--worker N]             drain the task queue (claim->exec->verify->learn)
  tick                         run a single task
  status                       human-readable status mirror + metrics
  queues [add <q> "<title>"]   show or append momentum queues
  approvals                    list pending approvals
  approve|deny <id>            decide an approval
  trust                        per-domain trust levels
  knowledge "<q>"              search durable knowledge
  scan                         proactive scan -> momentum items
  recurring [add|seed]         list/add recurring ops (--name --action --every)
  cron-tick                    run all due recurring jobs (wire to host cron/loop)
  harness [contract|finance] <file>   run a specialized harness (5-phase, deterministic)
  saga onboard <email> [--fail-at N]  run an idempotent saga (compensates on failure)
  effects [sagaId] | saga             list the side-effect ledger / recent sagas
  mine                         mine repeated successes -> a reusable playbook (eval-guarded)
  improve [--bad]              run the one-change loop (keep/auto-revert on eval delta)
  improvements                 show the improvement ledger
  intel                        external-intelligence digest -> ranked experiments
  eval                         run the eval suite, record pass rate
  serve [--port N]             start the control-plane dashboard + API

Safety: LLM execution is ${POLICY.allowClaude ? "ENABLED" : "GATED (set OMNI_ALLOW_CLAUDE=1)"}.`);
  }
}

main().catch((e) => { log.err(e.stack || e.message); process.exit(1); });
