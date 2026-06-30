// Central configuration. Resolves the omni root, key paths, and runtime policy from env.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), "..");

const STATE = process.env.OMNI_STATE || path.join(ROOT, "state");
export const PATHS = {
  root: ROOT,
  state: STATE, // entity.json, user-profile.json, effects-demo.json, etc. (isolate via OMNI_STATE)
  db: process.env.OMNI_DB || path.join(STATE, "omni.db"),
  queues: process.env.OMNI_QUEUES || path.join(STATE, "queues.json"),
  projects: process.env.OMNI_PROJECTS || path.join(ROOT, "projects"),
  playbooks: path.join(ROOT, "playbooks"),
  profiles: path.join(ROOT, "profiles"),
  skills: path.join(ROOT, "skills"),
  evals: path.join(ROOT, "evals"),
  incidents: path.join(ROOT, "incidents"),
};

// Policy / safety knobs (safe-by-default).
export const POLICY = {
  // Real LLM execution (claude -p) is OFF unless explicitly enabled.
  allowClaude: process.env.OMNI_ALLOW_CLAUDE === "1",
  claudeBin: process.env.OMNI_CLAUDE_BIN || "claude",
  claudeModel: process.env.OMNI_CLAUDE_MODEL || "", // empty = engine default
  // Hard task timeout (ms). Default 30 min per the recommended defaults.
  taskTimeoutMs: Number(process.env.OMNI_TASK_TIMEOUT_MS || 30 * 60 * 1000),
  // Default automatic retry budget for ordinary execution failure.
  maxAttempts: Number(process.env.OMNI_MAX_ATTEMPTS || 2),
  // Lock lease before a claimed task is considered stuck and reclaimable.
  lockLeaseMs: Number(process.env.OMNI_LOCK_LEASE_MS || 30 * 60 * 1000),
  // Max sub-delegation depth.
  maxDelegationDepth: Number(process.env.OMNI_MAX_DEPTH || 5),
  // Risk levels that require an approval before dispatch (side effects).
  approvalRequiredRisk: (process.env.OMNI_APPROVAL_RISK || "high,critical").split(","),
  // Default daily cost budget (USD). Soft guardrail; pauses LLM work when exceeded.
  dailyCostLimit: Number(process.env.OMNI_DAILY_COST_LIMIT || 5),
  serverPort: Number(process.env.OMNI_PORT || 7777),
};

export const RISK_ORDER = ["low", "medium", "high", "critical"];

// The entity's "brain". An OpenAI-compatible endpoint is the intended last step: set
// OMNI_LLM_ENDPOINT (+ MODEL) to connect any server speaking /v1/chat/completions
// (vLLM, Ollama, LM Studio, llama.cpp, OpenAI, ...). Until then the entity runs on a
// deterministic router brain and degrades gracefully.
export const LLM = {
  provider: process.env.OMNI_LLM_PROVIDER || "auto", // auto|openai|claude|none
  endpoint: process.env.OMNI_LLM_ENDPOINT || "",     // e.g. http://localhost:11434/v1
  model: process.env.OMNI_LLM_MODEL || "",
  apiKey: process.env.OMNI_LLM_API_KEY || "",
  maxTokens: Number(process.env.OMNI_LLM_MAX_TOKENS || 1024),
  temperature: Number(process.env.OMNI_LLM_TEMPERATURE || 0.3),
};

export const ENTITY_NAME = process.env.OMNI_ENTITY_NAME || "Omni";

export function ensureDirs() {
  for (const p of [
    PATHS.state,
    PATHS.projects,
    PATHS.playbooks,
    PATHS.profiles,
    PATHS.skills,
    PATHS.incidents,
  ]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

export function nowIso() {
  return new Date().toISOString();
}
