// Claude executor (GATED). Wraps `claude -p` headless as a replaceable execution engine for
// open-ended reasoning/coding tasks. OFF unless OMNI_ALLOW_CLAUDE=1 (no surprise spend/actions).
// Runs in the project workspace dir; transcript + cost/tokens captured as evidence.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { POLICY } from "../config.mjs";

export const name = "claude";
export const handles = ["llm", "review", "research"];

const SYSTEM_PREAMBLE =
  "You are an omni worker executing one scoped task. Work only inside the current directory. " +
  "Produce concrete artifacts (files), keep changes minimal and verifiable, and end with a short " +
  "summary of exactly what you changed and how to verify it.";

// Reusable gated call to `claude -p`. Returns { ok, gated?, text, cost, tokens, exitCode, error }.
// Shared by the executor and by harness enrichment phases so there's one place for the engine.
export function callClaude(prompt, opts = {}) {
  if (!POLICY.allowClaude) {
    return { ok: false, gated: true, exitCode: 0, text: "", cost: 0, tokens: 0 };
  }
  const args = ["-p", "--output-format", "json"];
  if (POLICY.claudeModel) args.push("--model", POLICY.claudeModel);
  args.push("--permission-mode", opts.permissionMode || process.env.OMNI_CLAUDE_PERMISSION_MODE || "acceptEdits");

  const res = spawnSync(POLICY.claudeBin, args, {
    cwd: opts.cwd || process.cwd(),
    input: prompt,
    encoding: "utf8",
    timeout: POLICY.taskTimeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (opts.runDir) {
    try {
      fs.writeFileSync(path.join(opts.runDir, `claude.${opts.label || "out"}.json`), res.stdout || "");
      if (res.stderr) fs.writeFileSync(path.join(opts.runDir, `claude.${opts.label || "out"}.stderr.log`), res.stderr);
    } catch { /* best effort */ }
  }
  let parsed = null;
  try { parsed = JSON.parse(res.stdout || ""); } catch { /* non-JSON */ }
  const exitCode = res.status ?? (res.error ? 124 : 0);
  const isError = parsed ? !!parsed.is_error : exitCode !== 0;
  return {
    ok: !isError && exitCode === 0,
    exitCode,
    text: parsed?.result ?? (res.stdout || "").slice(0, 4000),
    cost: parsed?.total_cost_usd ?? 0,
    tokens: (parsed?.usage?.input_tokens ?? 0) + (parsed?.usage?.output_tokens ?? 0),
    error: res.error ? res.error.message : undefined,
  };
}

export async function execute(task, ctx) {
  const prompt = `${SYSTEM_PREAMBLE}\n\nTASK: ${task.title}\n\n${task.description || (task.spec && task.spec.prompt) || ""}`;
  const r = callClaude(prompt, { cwd: ctx.cwd || ctx.workspaceDir, runDir: ctx.runDir, label: "task" });
  if (r.gated) {
    return {
      ok: false, gated: true, exitCode: 0,
      summary: "claude executor is gated. Enable with OMNI_ALLOW_CLAUDE=1. Task left pending; no LLM cost.",
    };
  }
  return {
    ok: r.ok, exitCode: r.exitCode,
    summary: (r.text || "claude run complete").slice(0, 1200),
    cost: r.cost, tokens: r.tokens, artifacts: [], error: r.error,
  };
}
