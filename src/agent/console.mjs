// Rich interactive terminal for the entity. Slash-commands for power use, natural language for
// everything else, tab-completion, persistent history, a spinner for slow actions — zero deps.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PATHS, ENTITY_NAME, nowIso } from "../config.mjs";
import { converse } from "./converse.mjs";
import { getIdentity, getUserProfile, setUserName } from "./identity.mjs";
import { startConversation, recentTurns } from "./conversation.mjs";
import { modelStatus } from "../llm/index.mjs";
import { statusReport, metricsSummary } from "../status.mjs";
import { listTasks } from "../core/tasks.mjs";
import { allQueues } from "../core/queues.mjs";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", b: "\x1b[34m", c: "\x1b[36m",
  g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", mag: "\x1b[35m", gray: "\x1b[90m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (k, s) => (useColor ? C[k] + s + C.reset : s);
const HIST_FILE = path.join(PATHS.state, "console-history");

const SLASH = {
  "/help": "show commands", "/status": "live status snapshot", "/model": "brain (model) status",
  "/tasks": "list tasks [status]", "/queues": "momentum queues", "/identity": "the entity's self",
  "/harness": "<contract|finance|incident|research> <file>", "/scan": "proactive scan",
  "/evolve": "run the self-improvement loop", "/intel": "external-intelligence digest",
  "/eval": "run the eval suite", "/remember": "<text> — remember a fact", "/recall": "<query>",
  "/saga": "onboard <email>", "/name": "<your name>", "/history": "recent conversation",
  "/clear": "clear the screen", "/exit": "leave",
};

function banner() {
  const id = getIdentity();
  const m = modelStatus();
  const art = [
    "   ____  __  __ _   _ ___ ",
    "  / __ \\|  \\/  | \\ | |_ _|",
    " | |  | | |\\/| |  \\| || | ",
    " | |__| | |  | | |\\  || | ",
    "  \\____/|_|  |_|_| \\_|___|",
  ].join("\n");
  console.log("\n" + col("c", art));
  console.log(col("dim", `  ${id.name} · agentic operating system · v${id.version}`));
  console.log("  brain: " + (m.connected ? col("g", "● model connected (" + m.provider + ")") : col("y", "○ deterministic (no model yet — /model to connect)")));
  console.log(col("dim", `  type naturally, or use /commands · tab-completes · /help · /exit\n`));
}

function spinner(label) {
  if (!useColor) { process.stdout.write(label + " ...\n"); return () => {}; }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => { process.stdout.write(`\r${col("c", frames[i++ % frames.length])} ${col("dim", label)}   `); }, 80);
  return () => { clearInterval(t); process.stdout.write("\r" + " ".repeat(label.length + 8) + "\r"); };
}

function name() { return col("mag", getIdentity().name); }
function reply(text) { console.log(`\n${name()} ${col("dim", "›")} ${text}\n`); }

async function viaConverse(rl, phrase, label) {
  const stop = spinner(label || "working");
  try { const r = await converse(phrase, { conversationId: rl._omniCid }); reply(r.reply); }
  finally { stop(); }
}

async function handleSlash(rl, line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/help": {
      console.log("\n" + col("bold", "Commands") + "  " + col("dim", "(or just type naturally)"));
      for (const [k, v] of Object.entries(SLASH)) console.log(`  ${col("c", k.padEnd(10))} ${col("dim", v)}`);
      console.log();
      break;
    }
    case "/status": {
      const m = metricsSummary(), s = statusReport();
      console.log(`\n  tasks ${col("g", m.tasks_completed + "/" + m.tasks_total)} done · ${m.tasks_verified} verified · ${col(m.tasks_failed ? "r" : "dim", m.tasks_failed + " failed")}`);
      console.log(`  evals ${col("g", (m.eval_pass_rate == null ? "n/a" : Math.round(m.eval_pass_rate * 100) + "%"))} · spend $${m.cost_total_usd} · approvals ${(s.approvals || []).length}`);
      console.log(`  active: ${(s.queues.now || []).length} · next: ${(s.queues.next || []).slice(0, 2).map((q) => q.title.slice(0, 30)).join(", ") || "—"}\n`);
      break;
    }
    case "/model": {
      const m = modelStatus();
      if (m.connected) console.log("\n  " + col("g", "● connected via " + m.provider + (m.model ? " (" + m.model + ")" : "") + (m.endpoint ? " @ " + m.endpoint : "")) + "\n");
      else {
        console.log("\n  " + col("y", "○ no model connected") + col("dim", " — running on the deterministic brain"));
        console.log(col("dim", "  connect one (the last step):"));
        console.log(col("c", "    export OMNI_LLM_ENDPOINT=http://localhost:11434/v1"));
        console.log(col("c", "    export OMNI_LLM_MODEL=llama3.1"));
        console.log(col("dim", "  then restart the console. See docs/CONNECT_MODEL.md\n"));
      }
      break;
    }
    case "/tasks": {
      const ts = listTasks(arg ? { status: arg } : {}).slice(0, 15);
      console.log();
      for (const t of ts) console.log(`  ${col("dim", t.status.padEnd(13))} ${t.title.slice(0, 50)} ${col("gray", t.kind)}`);
      if (!ts.length) console.log(col("dim", "  (no tasks)"));
      console.log();
      break;
    }
    case "/queues": {
      const q = allQueues();
      console.log();
      for (const name of ["now", "next", "blocked", "improve", "recurring"]) {
        const items = (q[name] || []).slice(0, 3).map((i) => i.title.slice(0, 40)).join(col("dim", " · "));
        console.log(`  ${col("c", name.padEnd(9))} ${items || col("dim", "—")}`);
      }
      console.log();
      break;
    }
    case "/identity": {
      const id = getIdentity();
      console.log(`\n  ${col("bold", id.name)} — born ${id.born.slice(0, 10)}, v${id.version}`);
      console.log(col("dim", "  " + id.persona));
      for (const n of id.selfNotes.slice(0, 4)) console.log(col("gray", `  · ${n.at.slice(0, 10)} ${n.note}`));
      console.log();
      break;
    }
    case "/history": {
      console.log();
      for (const t of recentTurns(rl._omniCid, 10)) console.log(`  ${col(t.role === "user" ? "b" : "mag", t.role)} ${t.content.slice(0, 70)}`);
      console.log();
      break;
    }
    case "/clear": console.clear(); banner(); break;
    case "/name": if (arg) { setUserName(arg); reply(`I'll remember you as ${arg}.`); } else reply("Usage: /name <your name>"); break;
    case "/remember": arg ? await viaConverse(rl, "remember " + arg, "remembering") : reply("Usage: /remember <text>"); break;
    case "/recall": await viaConverse(rl, "what do you know about " + arg, "recalling"); break;
    case "/harness": await viaConverse(rl, "harness " + arg, "running harness"); break;
    case "/saga": await viaConverse(rl, "saga " + arg, "running saga"); break;
    case "/scan": await viaConverse(rl, "scan", "scanning"); break;
    case "/evolve": await viaConverse(rl, "evolve", "evolving (running evals)"); break;
    case "/intel": await viaConverse(rl, "what's new", "scanning the ecosystem"); break;
    case "/eval": await viaConverse(rl, "run your tests", "running evals"); break;
    case "/exit": case "/quit": rl.close(); break;
    default: console.log(col("y", `  unknown command ${cmd} — /help for the list`));
  }
}

export async function startConsole() {
  fs.mkdirSync(PATHS.state, { recursive: true });
  banner();
  const cid = startConversation("console");
  const completer = (line) => {
    const hits = Object.keys(SLASH).filter((c) => c.startsWith(line));
    return [hits.length ? hits : [], line];
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: col("b", "you ") + col("dim", "› "), completer, historySize: 200 });
  rl._omniCid = cid;
  try { rl.history = fs.readFileSync(HIST_FILE, "utf8").split("\n").filter(Boolean).reverse(); } catch { /* no history yet */ }

  // Serialize turns via a promise chain so fast/piped input never interleaves, and so end-of-input
  // ('close') waits for in-flight turns to finish before exiting (replies always print).
  let chain = Promise.resolve();
  let closing = false;
  rl.prompt();
  rl.on("line", (line) => {
    const msg = line.trim();
    if (!msg) { if (!closing) rl.prompt(); return; }
    chain = chain.then(async () => {
      if (closing) return;
      try { fs.appendFileSync(HIST_FILE, msg + "\n"); } catch { /* best effort */ }
      if (/^(exit|quit|bye)$/i.test(msg)) { closing = true; rl.close(); return; }
      try {
        if (msg.startsWith("/")) await handleSlash(rl, msg);
        else { const stop = spinner("thinking"); try { const r = await converse(msg, { conversationId: cid }); stop(); reply(r.reply); } finally { stop(); } }
      } catch (e) { console.log(col("r", "  error: " + e.message)); }
      if (!closing) rl.prompt();
    });
  });
  rl.on("close", async () => {
    closing = true;
    await chain;
    console.log(col("dim", `\n${getIdentity().name} › until next time.\n`));
    process.exit(0);
  });
}
