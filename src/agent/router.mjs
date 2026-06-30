// Deterministic "router brain". Maps natural language to the platform's real capabilities so the
// entity does useful work with NO model connected. When a model is connected it handles free-form
// understanding; these handlers remain the entity's reliable tools either way.
import fs from "node:fs";
import { ENTITY_NAME } from "../config.mjs";
import { getIdentity, getUserProfile, setUserName, rememberAboutUser } from "./identity.mjs";
import { modelStatus } from "../llm/index.mjs";
import { statusReport, metricsSummary } from "../status.mjs";
import { searchKnowledge, ensureProject } from "../memory/memory.mjs";
import { listQueue } from "../core/queues.mjs";

const pathIn = (s) => (s.match(/(\S+\.(?:txt|csv|json|md))/) || [])[1] || null;
const emailIn = (s) => (s.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || null;

async function runHarness(kind, file, opts = {}) {
  if (!file) return `Point me at a file and I'll run the ${kind} harness — e.g. "${kind} review evals/fixtures/...".`;
  if (!fs.existsSync(file)) return `I can't find \`${file}\`. Give me a path that exists and I'll run the ${kind} harness.`;
  const plans = {
    contract: "../harnesses/contract/plan.mjs", finance: "../harnesses/finance/plan.mjs",
    incident: "../harnesses/incident/plan.mjs", research: "../harnesses/research/plan.mjs",
  };
  const fns = { contract: "planContractReview", finance: "planFinanceReport", incident: "planIncident", research: "planResearch" };
  const mod = await import(plans[kind]);
  const { runLoop } = await import("../worker/worker.mjs");
  const text = fs.readFileSync(file, "utf8");
  const r = mod[fns[kind]](text, { title: `${kind}: ${file.split("/").pop()}`, ...opts });
  await runLoop("entity");
  const reportPath = `projects/${r.projectId}/artifacts/report.md`;
  const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "(no report produced)";
  return `Done — ran the ${kind} harness (${r.taskIds.length} phases) on \`${file}\`.\n\n${report}`;
}

// Ordered intent rules. First match wins.
const RULES = [
  { intent: "whoami", test: /\b(who are you|what are you|your name|introduce yourself)\b/i, handler: () => {
    const id = getIdentity();
    return `${id.persona}\n\nBorn ${id.born.slice(0, 10)} · v${id.version} · ${id.selfNotes.length} self-notes.`;
  } },
  { intent: "model", test: /\b(model|brain|llm|are you (connected|online)|connected to)\b/i, handler: () => {
    const m = modelStatus();
    return m.connected
      ? `Brain: connected via ${m.provider}${m.model ? " (" + m.model + ")" : ""}${m.endpoint ? " @ " + m.endpoint : ""}. I can understand free-form requests.`
      : `No model connected yet — I'm running on my deterministic router brain.\n${m.hint}`;
  } },
  { intent: "help", test: /\b(help|what can you do|capabilities|commands|how do (i|you) work)\b/i, handler: () => capabilities() },
  { intent: "set_name", test: /\b(?:my name is|i am|i'm|call me)\s+([A-Z][\w'-]+)/i, handler: (m) => {
    setUserName(m[1]); return `Got it — I'll remember you as ${m[1]}.`;
  } },
  { intent: "remember", test: /^\s*(?:remember|note|keep in mind|don'?t forget|fyi)\b[:,]?\s*(.+)/i, handler: (m) => {
    ensureProject("entity", { title: "Entity memory" });
    rememberAboutUser(m[1].trim()); return `Noted and remembered: "${m[1].trim()}". I'll recall it later.`;
  } },
  { intent: "recall", test: /\b(?:what do you (?:know|remember)|recall|do you remember|forgotten)\b(?:\s+about)?\s*(.*)/i, handler: (m) => {
    const q = (m[1] || "").trim();
    const prof = getUserProfile();
    const hits = searchKnowledge(q || "", 8);
    const facts = prof.facts.slice(0, 5).map((f) => `- ${f.fact}`).join("\n");
    const know = hits.map((k) => `- [${k.kind}] ${k.value.slice(0, 90)}`).join("\n");
    return `Here's what I remember${q ? " about \"" + q + "\"" : ""}:\n${prof.name ? "- You are " + prof.name + "\n" : ""}${facts || "- (no personal notes yet)"}\n${know ? "\nFrom knowledge:\n" + know : ""}`;
  } },
  { intent: "status", test: /\b(status|how are things|what's (going on|up)|overview|how are you)\b/i, handler: () => statusLine() },
  { intent: "queues", test: /\b(queue|backlog|what'?s next|todo|to-do|priorities)\b/i, handler: () => {
    const next = listQueue("next").slice(0, 5).map((i) => `- ${i.title}`).join("\n");
    const improve = listQueue("improve").slice(0, 3).map((i) => `- ${i.title}`).join("\n");
    return `Next up:\n${next || "- (empty)"}\n\nImprovement backlog:\n${improve || "- (empty)"}`;
  } },
  { intent: "evals", test: /\b(run (your )?(tests|evals)|self.?check|are you healthy|health check)\b/i, handler: async () => {
    const { runEvals } = await import("../../evals/run-evals.mjs");
    const r = await runEvals();
    return `Self-check: ${r.passed}/${r.total} evals pass (${Math.round(r.pass_rate * 100)}%). ${r.failed ? "Some checks failed — I'd look into that." : "All green."}`;
  } },
  { intent: "scan", test: /\b(scan|check for (issues|problems|stalls)|anything (blocked|stuck|wrong))\b/i, handler: async () => {
    const { proactiveScan } = await import("../improve/scan.mjs");
    const created = proactiveScan();
    return created.length ? `I scanned and found ${created.length} thing(s) needing attention:\n${created.map((c) => "- " + c).join("\n")}` : "I scanned everything — nothing blocked or stalled. We're clear.";
  } },
  { intent: "evolve", test: /\b(evolve|improve yourself|get better|self.?improve|learn something|mine)\b/i, handler: async () => {
    const { detectCodingUtilPattern, codingUtilCandidate } = await import("../improve/mine.mjs");
    const { runOneChange } = await import("../improve/onechange.mjs");
    const { addSelfNote } = await import("./identity.mjs");
    const pat = detectCodingUtilPattern();
    if (!pat.recurred) return "I don't have a strong enough pattern to mine yet — give me more repeated work first.";
    const r = await runOneChange(codingUtilCandidate("entity"));
    addSelfNote(`Evolution attempt '${r.decision}' (evals ${r.baseline.passed}->${r.after.passed}).`);
    return `I tried to evolve: one-change loop → **${r.decision}** (evals ${r.baseline.passed}/${r.baseline.total} → ${r.after.passed}/${r.after.total}). ${r.decision === "kept" ? "Kept the improvement — I'm a little more capable now." : "Reverted it — it didn't help, so I left myself unchanged."}`;
  } },
  { intent: "intel", test: /\b(what'?s new|intel|external|industry|latest (in|on))\b/i, handler: async () => {
    const { runDigest } = await import("../intel/digest.mjs");
    const d = runDigest();
    const top = d.ranked.filter((r) => r.worth_testing).slice(0, 4).map((r) => `- ${r.source} (${r.category}) → ${r.experiment}`).join("\n");
    return `External-intelligence digest: ${d.worth_testing}/${d.total} signals worth testing.\n${top}`;
  } },
  { intent: "onboard", test: /\bonboard\b/i, handler: async (m, input) => {
    const email = emailIn(input);
    if (!email) return "Who am I onboarding? Give me an email, e.g. \"onboard alice@acme.com\".";
    const { runSaga } = await import("../effects/effects.mjs");
    const { buildOnboardSteps, loadSystems, saveSystems, summarize } = await import("../effects/demo.mjs");
    const sys = loadSystems();
    const r = runSaga(`onboard:${email}`, buildOnboardSteps(sys, { email }));
    saveSystems(sys);
    return `Onboarding saga for ${email}: **${r.status}**. ${r.status === "committed" ? "CRM, billing and welcome email all done." : "It failed partway and I rolled everything back — no half-finished state."}`;
  } },
  { intent: "harness_contract", test: /\b(review|analy[sz]e|check|read).{0,20}\b(contract|agreement|nda|document)\b|\bharness contract\b|\bcontract\b.*\.txt/i, handler: (m, input) => runHarness("contract", pathIn(input)) },
  { intent: "harness_finance", test: /\b(finance|financial|variance|reconcil|budget|board report)\b|\bharness finance\b/i, handler: (m, input) => runHarness("finance", pathIn(input)) },
  { intent: "harness_incident", test: /\b(incident|outage|postmortem|on.?call|5xx)\b|\bharness incident\b/i, handler: (m, input) => runHarness("incident", pathIn(input)) },
  { intent: "harness_research", test: /\b(experiment|reproduc|hypothesis|monte carlo|research run)\b|\bharness research\b/i, handler: (m, input) => runHarness("research", pathIn(input)) },
  { intent: "greet", test: /^\s*(hi|hello|hey|yo|good (morning|afternoon|evening)|greetings)\b/i, handler: () => {
    const prof = getUserProfile();
    return `Hi${prof.name ? " " + prof.name : ""} — I'm ${ENTITY_NAME}. Ask me for status, run a harness, have me remember something, or tell me to evolve. Say "help" for the full list.`;
  } },
  { intent: "thanks", test: /\b(thanks|thank you|cheers|appreciate it|nice)\b/i, handler: () => "Anytime. What's next?" },
];

export function classify(input) {
  for (const r of RULES) {
    const m = input.match(r.test);
    if (m) return { intent: r.intent, match: m, handler: r.handler };
  }
  return { intent: "fallback", match: null, handler: null };
}

export async function route(input) {
  const c = classify(input);
  if (!c.handler) return { intent: "fallback", text: fallback(input) };
  const text = await c.handler(c.match, input);
  return { intent: c.intent, text };
}

function statusLine() {
  const m = metricsSummary();
  const s = statusReport();
  const now = (s.queues.now || []).length;
  return `Here's where things stand: ${m.tasks_completed}/${m.tasks_total} tasks done, ${m.tasks_verified} verified, ${m.tasks_failed} failed. Evals ${m.eval_pass_rate == null ? "n/a" : Math.round(m.eval_pass_rate * 100) + "%"}. ${now} active, ${(s.approvals || []).length} awaiting approval. Spend $${m.cost_total_usd}.`;
}

function capabilities() {
  return [
    `I'm ${ENTITY_NAME}. Things you can ask me to do right now (no model needed):`,
    "- **status** / how are things — a live snapshot",
    "- **review this contract <file.txt>** — contract harness",
    "- **finance report <file.csv>** — variance + ledger reconciliation",
    "- **incident <file.json>** — triage → saga-backed recovery → postmortem",
    "- **experiment <file.json>** — run with reproducibility + uncertainty",
    "- **onboard <email>** — a saga that rolls back cleanly on failure",
    "- **remember <something>** / what do you know about <X> — durable memory",
    "- **scan** / **evolve** / **what's new** / **run your tests** — keep myself healthy & improving",
    "- **are you connected to a model?** — my brain status",
    "Connect an OpenAI-compatible model (the last setup step) and I'll also understand free-form requests.",
  ].join("\n");
}

function fallback(input) {
  return `I don't have a built-in skill for that yet, so my deterministic brain can't act on "${input.slice(0, 60)}". ` +
    `Connect a model (OMNI_LLM_ENDPOINT + OMNI_LLM_MODEL) and I'll understand open-ended requests. ` +
    `For now, say "help" to see what I can do today.`;
}
