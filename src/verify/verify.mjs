// Verifier layer. Independent of the executor: it re-checks reality and produces EVIDENCE.
// A task is never self-certified. Methods are declarative (task.verification_plan).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { POLICY } from "../config.mjs";
import { checksum } from "../ids.mjs";
import { get } from "../db.mjs";

// Returns { passed: true|false|null, method, evidence:[...] }  (null = needs human)
// Checks run in ctx.cwd when present (e.g. a worktree), else the project workspace.
export async function verify(task, ctx) {
  const plan = task.verification_plan || { method: "none" };
  const base = ctx.cwd || ctx.workspaceDir;
  const ev = [];
  switch (plan.method) {
    case "none":
      return { passed: true, method: "none", evidence: [{ kind: "note", value: "no verification required" }] };

    case "file_exists": {
      let ok = true;
      for (const rel of plan.paths || []) {
        const fp = path.join(base, rel);
        const exists = fs.existsSync(fp);
        ev.push({ kind: "file_exists", path: rel, ok: exists });
        if (!exists) ok = false;
      }
      return { passed: ok, method: "file_exists", evidence: ev };
    }

    case "file_contains": {
      const fp = path.join(base, plan.path);
      const exists = fs.existsSync(fp);
      const content = exists ? fs.readFileSync(fp, "utf8") : "";
      const ok = exists && content.includes(plan.substring);
      ev.push({ kind: "file_contains", path: plan.path, substring: plan.substring, ok });
      return { passed: ok, method: "file_contains", evidence: ev };
    }

    case "checksum": {
      const fp = path.join(base, plan.path);
      const ok = fs.existsSync(fp) && checksum(fs.readFileSync(fp)) === plan.checksum;
      ev.push({ kind: "checksum", path: plan.path, ok });
      return { passed: ok, method: "checksum", evidence: ev };
    }

    case "command": {
      const cwd = plan.cwd ? path.join(base, plan.cwd) : base;
      const res = spawnSync("/bin/sh", ["-c", plan.cmd], {
        cwd, encoding: "utf8", timeout: POLICY.taskTimeoutMs, maxBuffer: 16 * 1024 * 1024,
      });
      const exit = res.status ?? (res.error ? 124 : 0);
      const expect = plan.expectExit ?? 0;
      const ok = exit === expect;
      ev.push({
        kind: "command", cmd: plan.cmd, exit, expect, ok,
        tail: (res.stdout || "").slice(-400) + (res.stderr ? "\n[stderr]\n" + res.stderr.slice(-400) : ""),
      });
      return { passed: ok, method: "command", evidence: ev };
    }

    case "node_test": {
      // Hardened test verification: 0 tests is NOT a pass (node --test exits 0 with no files).
      const cwd = plan.cwd ? path.join(base, plan.cwd) : base;
      const res = spawnSync("/bin/sh", ["-c", plan.cmd || "node --test --no-warnings"], {
        cwd, encoding: "utf8", timeout: POLICY.taskTimeoutMs, maxBuffer: 16 * 1024 * 1024,
      });
      const exit = res.status ?? (res.error ? 124 : 0);
      const out = (res.stdout || "") + "\n" + (res.stderr || "");
      const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
      const tests = num(/tests (\d+)/);
      const pass = num(/pass (\d+)/);
      const fail = num(/fail (\d+)/);
      const ok = exit === 0 && tests != null && tests > 0 && fail === 0;
      ev.push({ kind: "node_test", exit, tests, pass, fail, ok, tail: out.slice(-400) });
      return { passed: ok, method: "node_test", evidence: ev };
    }

    case "json_has": {
      // Independent schema check on a workspace JSON artifact: parses, has required keys,
      // and (for arrays) meets a minimum item count. Schemas at phase boundaries.
      const fp = path.join(base, plan.path);
      let ok = fs.existsSync(fp), parsed = null, reason = ok ? "" : "missing file";
      if (ok) {
        try { parsed = JSON.parse(fs.readFileSync(fp, "utf8")); }
        catch (e) { ok = false; reason = "invalid json"; }
      }
      if (ok && plan.minItems != null) {
        if (!Array.isArray(parsed) || parsed.length < plan.minItems) { ok = false; reason = `expected >=${plan.minItems} items`; }
      }
      if (ok && plan.requireKeys) {
        const obj = Array.isArray(parsed) ? parsed[0] || {} : parsed;
        for (const k of plan.requireKeys) if (!(k in obj)) { ok = false; reason = `missing key '${k}'`; }
      }
      ev.push({ kind: "json_has", path: plan.path, ok, reason });
      return { passed: ok, method: "json_has", evidence: ev };
    }

    case "knowledge_present": {
      const row = get(
        `SELECT id FROM knowledge WHERE project_id=? AND key=? ORDER BY updated_at DESC LIMIT 1`,
        task.project_id, plan.key
      );
      ev.push({ kind: "knowledge_present", key: plan.key, ok: !!row });
      return { passed: !!row, method: "knowledge_present", evidence: ev };
    }

    case "manual":
      return { passed: null, method: "manual", evidence: [{ kind: "note", value: plan.note || "needs human review" }] };

    default:
      return { passed: null, method: plan.method, evidence: [{ kind: "note", value: "unknown verification method" }] };
  }
}
