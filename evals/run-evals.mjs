// Eval runner. Spawns the harness in an isolated temp DB + temp projects dir so evals never
// touch operator state, parses its JSON summary, and records the run + per-scenario rows into
// the REAL operational DB (so pass-rate trends + regressions are queryable and visible).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, J } from "../src/db.mjs";
import { id } from "../src/ids.mjs";
import { nowIso } from "../src/config.mjs";
import { emit } from "../src/events.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runEvals(suite = "core") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-eval-"));
  const env = {
    ...process.env,
    OMNI_STATE: path.join(tmp, "state"),
    OMNI_DB: path.join(tmp, "eval.db"),
    OMNI_PROJECTS: path.join(tmp, "projects"),
    OMNI_QUEUES: path.join(tmp, "queues.json"),
    OMNI_ALLOW_CLAUDE: "0",
    OMNI_LLM_ENDPOINT: "",
    OMNI_LLM_PROVIDER: "auto",
  };
  const startedAt = nowIso();
  const res = spawnSync("node", [path.join(__dirname, "harness.mjs")], {
    env, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
  });

  let parsed;
  try {
    parsed = JSON.parse(res.stdout.trim().split("\n").pop());
  } catch {
    return {
      total: 0, passed: 0, failed: 1, pass_rate: 0,
      results: [{ scenario: "harness", status: "fail", detail: (res.stderr || res.stdout || "no output").slice(-600) }],
    };
  }

  const runId = id("evalrun");
  const passRate = parsed.total ? parsed.passed / parsed.total : 0;
  run(
    `INSERT INTO eval_runs (id,suite,total,passed,failed,pass_rate,meta,started_at,ended_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    runId, suite, parsed.total, parsed.passed, parsed.failed, passRate, J({ tmp }), startedAt, nowIso()
  );
  for (const r of parsed.results) {
    run(
      `INSERT INTO evals (id,run_id,suite,scenario,status,score,detail,ts) VALUES (?,?,?,?,?,?,?,?)`,
      id("eval"), runId, suite, r.scenario, r.status, r.score ?? (r.status === "pass" ? 1 : 0), r.detail || "", nowIso()
    );
  }
  emit("eval.run", {
    level: parsed.failed ? "warn" : "success",
    message: `evals ${parsed.passed}/${parsed.total} (${(passRate * 100).toFixed(0)}%)`,
    data: { runId, passRate },
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return { ...parsed, pass_rate: passRate, runId };
}
