// External-intelligence loop. Converts outside signals into ranked, testable experiments —
// it does not just collect news. Selection rule (from doctrine): prioritize durable execution,
// state machines, checkpointing, typed contracts, memory/retrieval, model routing, sandboxing,
// validation/evals, approvals/control-plane, traceability/protocols. Deprioritize thin wrappers,
// generic chat shells, and UI-only products. Nothing is adopted without a local eval/experiment.
import fs from "node:fs";
import { all } from "../db.mjs";
import { id } from "../ids.mjs";
import { nowIso, PATHS } from "../config.mjs";
import { run, J } from "../db.mjs";
import { emit } from "../events.mjs";
import { addQueueItem } from "../core/queues.mjs";

const POSITIVE = [
  "durable execution", "state machine", "checkpoint", "resumable", "typed", "schema", "contract",
  "memory", "retrieval", "model routing", "gateway", "sandbox", "eval", "trace", "observability",
  "protocol", "approval", "control plane", "lineage", "reproducib", "workflow",
];
const NEGATIVE = ["thin wrapper", "chat shell", "ui-only", "no public architecture", "marketing", "demo without"];

const EXPERIMENT_BY_CATEGORY = {
  orchestration: "Prototype an explicit resumable sub-workflow and compare to the current worker loop on a long task.",
  durable: "Add a step-level checkpoint/replay to a multi-phase playbook; measure resume-after-failure.",
  memory: "Test the retrieval pattern on a long-horizon goal; measure memory-reuse rate.",
  gateway: "Shadow-route a task class through a model gateway; compare cost-to-pass.",
  sandbox: "Run a coding task in the alternate sandbox; compare isolation + setup latency.",
  eval: "Import the eval/trace pattern; add it to the harness and check for new failure detection.",
  protocol: "Expose one capability over the protocol; verify a portable round-trip.",
};

// Pure ranking (unit-testable). Returns items scored + sorted, with a worth_testing flag.
export function rankItems(items) {
  return items
    .map((it) => {
      const hay = `${it.claim} ${it.category}`.toLowerCase();
      const pos = POSITIVE.filter((s) => hay.includes(s)).length;
      const neg = NEGATIVE.filter((s) => hay.includes(s)).length;
      const score = pos * 2 - neg * 3;
      return {
        ...it,
        score,
        worth_testing: score > 0 && neg === 0,
        experiment: EXPERIMENT_BY_CATEGORY[it.category] || "Scope a bounded experiment and add an eval before adopting.",
      };
    })
    .sort((a, b) => b.score - a.score);
}

// Curated seed signals (open-source-first; representative of the reference set). Replace/extend
// with a live fetch source later; the pipeline is identical.
export const SEED = [
  { source: "LangGraph", url: "https://github.com/langchain-ai/langgraph", category: "durable", claim: "graph orchestration with durable execution, checkpointing, resumable human-in-the-loop state" },
  { source: "Temporal", url: "https://github.com/temporalio/temporal", category: "durable", claim: "durable execution, retries, timers, workflow versioning, checkpointing" },
  { source: "Letta", url: "https://github.com/letta-ai/letta", category: "memory", claim: "memory-first stateful agents with explicit memory blocks and retrieval" },
  { source: "LiteLLM", url: "https://github.com/BerriAI/litellm", category: "gateway", claim: "unified model gateway with budgets, routing, fallback" },
  { source: "Langfuse", url: "https://github.com/langfuse/langfuse", category: "eval", claim: "trace-centric observability, datasets, experiments, eval" },
  { source: "E2B", url: "https://github.com/e2b-dev/E2B", category: "sandbox", claim: "secure isolated sandboxes for AI-generated code execution" },
  { source: "MCP", url: "https://modelcontextprotocol.io/", category: "protocol", claim: "portable protocol/contract to connect agents to tools and data" },
  { source: "GenericChatWrapper", url: "https://example.com", category: "wrapper", claim: "thin wrapper around a provider API, chat shell, no public architecture" },
];

export function runDigest(items = SEED) {
  const ranked = rankItems(items);
  for (const r of ranked) {
    run(`INSERT INTO knowledge (id,project_id,kind,key,value,provenance,confidence,freshness,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id("kn"), null, "external", `${r.source}: ${r.category}`, `${r.claim} | experiment: ${r.experiment} | score ${r.score}`,
      r.url, r.worth_testing ? 0.7 : 0.2, nowIso(), nowIso(), nowIso());
  }
  const worth = ranked.filter((r) => r.worth_testing);
  for (const r of worth.slice(0, 3)) {
    addQueueItem("improve", { title: `Experiment (${r.source}): ${r.experiment}`, priority: 5, note: `${r.url} · score ${r.score}` });
  }
  const digest = { at: nowIso(), total: ranked.length, worth_testing: worth.length, ranked };
  fs.mkdirSync(PATHS.state, { recursive: true });
  fs.writeFileSync(`${PATHS.state}/intel-digest.json`, JSON.stringify(digest, null, 2));
  emit("intel.digest", { message: `${worth.length}/${ranked.length} signals worth testing`, data: { top: worth[0]?.source } });
  return digest;
}
