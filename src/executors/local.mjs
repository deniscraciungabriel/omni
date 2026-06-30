// Local executor (DEFAULT, safe, zero LLM cost). Performs deterministic "doing":
//   spec.writes  -> create files in the project workspace
//   spec.run     -> run a shell command in the workspace (sandboxed to cwd, timed out)
//   spec.knowledge -> record a durable knowledge entry
// Verification is a SEPARATE concern handled by the verifier, not here.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { POLICY } from "../config.mjs";
import { checksum } from "../ids.mjs";
import { appendKnowledge } from "../memory/memory.mjs";

export const name = "local";
export const handles = ["command", "memory", "scaffold"];

export async function execute(task, ctx) {
  const spec = task.spec || {};
  const notes = [];
  const artifacts = [];
  let exitCode = 0;

  // 1. File writes (content as a string, or contentLines as an array for legible playbooks)
  for (const f of spec.writes || []) {
    const fp = path.join(ctx.workspaceDir, f.path);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const body = f.content != null ? f.content : Array.isArray(f.contentLines) ? f.contentLines.join("\n") + "\n" : "";
    fs.writeFileSync(fp, body);
    const buf = fs.readFileSync(fp);
    artifacts.push({ path: path.relative(ctx.projectDir, fp), checksum: checksum(buf), kind: "file" });
    notes.push(`wrote ${f.path} (${buf.length}b)`);
  }

  // 2. Shell command (timed, captured)
  if (spec.run && spec.run.cmd) {
    const cwd = spec.run.cwd ? path.join(ctx.workspaceDir, spec.run.cwd) : ctx.workspaceDir;
    const res = spawnSync("/bin/sh", ["-c", spec.run.cmd], {
      cwd,
      timeout: POLICY.taskTimeoutMs,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    exitCode = res.status ?? (res.error ? 124 : 0);
    fs.writeFileSync(path.join(ctx.runDir, "stdout.log"), res.stdout || "");
    fs.writeFileSync(path.join(ctx.runDir, "stderr.log"), res.stderr || "");
    notes.push(`ran \`${spec.run.cmd}\` -> exit ${exitCode}`);
    if (res.error) notes.push(`error: ${res.error.message}`);
    if (exitCode !== 0) {
      return { ok: false, exitCode, summary: notes.join("; "), artifacts, tail: (res.stderr || res.stdout || "").slice(-800) };
    }
  }

  // 3. Knowledge side effect
  if (spec.knowledge) {
    appendKnowledge(task.project_id, spec.knowledge);
    notes.push(`recorded knowledge: ${spec.knowledge.key}`);
  }

  return { ok: true, exitCode, summary: notes.join("; ") || "no-op", artifacts };
}
