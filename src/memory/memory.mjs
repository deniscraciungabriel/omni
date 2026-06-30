// Memory subsystem. Canonical per-project state is the FILE PACK on disk; any compatible
// agent can enter projects/<id>/ and continue. The DB knowledge table indexes for search.
// Layers: episodic (runs), semantic (knowledge.md/facts), procedural (playbooks/skills),
// decisions, failures, status, handoff.
import fs from "node:fs";
import path from "node:path";
import { PATHS, nowIso } from "../config.mjs";
import { run, all, J } from "../db.mjs";
import { id } from "../ids.mjs";
import { emit } from "../events.mjs";

export function projectDir(projectId) {
  return path.join(PATHS.projects, projectId);
}
export function workspaceDir(projectId) {
  return path.join(projectDir(projectId), "artifacts");
}
export function runDir(projectId, sessionId) {
  return path.join(projectDir(projectId), "runs", sessionId);
}

function w(file, content) {
  fs.writeFileSync(file, content);
}
function append(file, content) {
  fs.appendFileSync(file, content);
}

// Create the canonical file pack for a project if missing.
export function ensureProject(projectId, info = {}) {
  const dir = projectDir(projectId);
  const exists = fs.existsSync(dir);
  fs.mkdirSync(workspaceDir(projectId), { recursive: true });
  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  if (!exists) {
    const title = info.title || projectId;
    const mode = info.mode || "general";
    const desc = info.description || "";
    w(path.join(dir, "project.md"),
`# Project: ${title}

- id: ${projectId}
- mode: ${mode}
- created: ${nowIso()}

## Charter
${desc || "_Describe the durable objective here._"}

## Source of truth
The files in this folder are the canonical, continuable state for this project.
Read before acting. Update during execution, not only at the end.
`);
    w(path.join(dir, "plan.md"),
`# Plan — ${title}

## Now
_(active focus)_

## Next
_(ready-to-run)_

## Later
_(rolling backlog)_
`);
    w(path.join(dir, "tasks.md"), `# Tasks — ${title}\n\n_(mirrored from the task graph; see \`omni status\`)_\n`);
    w(path.join(dir, "knowledge.md"), `# Knowledge — ${title}\n\nDistilled, durable facts and conventions. Newest first.\n`);
    w(path.join(dir, "decisions.md"), `# Decisions — ${title}\n\nWhy the direction changed. Newest first.\n`);
    w(path.join(dir, "status.md"), `# Status — ${title}\n\n_Updated automatically._\n`);
    w(path.join(dir, "handoff.md"), `# Handoff — ${title}\n\n- Next actions:\n- Blockers:\n- Open questions:\n`);
    w(path.join(dir, "FAILURE.md"), `# Failures — ${title}\n\nImportant failed attempts and what they teach. Newest first.\n`);
    emit("project.created", { project_id: projectId, message: title });
  }
  return dir;
}

export function appendKnowledge(projectId, entry) {
  // entry: { key, value, kind?, provenance?, confidence? }
  const kind = entry.kind || "semantic";
  append(path.join(projectDir(projectId), "knowledge.md"),
    `\n## ${entry.key}\n_${nowIso()} · ${kind} · conf ${entry.confidence ?? 0.6}${entry.provenance ? " · " + entry.provenance : ""}_\n\n${entry.value}\n`);
  run(
    `INSERT INTO knowledge (id,project_id,kind,key,value,provenance,confidence,freshness,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id("kn"), projectId, kind, entry.key, entry.value, entry.provenance || null,
    entry.confidence ?? 0.6, nowIso(), nowIso(), nowIso()
  );
  emit("memory.knowledge", { project_id: projectId, message: entry.key, data: { kind } });
}

export function recordDecision(projectId, title, body) {
  append(path.join(projectDir(projectId), "decisions.md"), `\n## ${title}\n_${nowIso()}_\n\n${body}\n`);
  emit("memory.decision", { project_id: projectId, message: title });
}

export function recordFailure(projectId, title, body) {
  append(path.join(projectDir(projectId), "FAILURE.md"), `\n## ${title}\n_${nowIso()}_\n\n${body}\n`);
  emit("memory.failure", { project_id: projectId, level: "warn", message: title });
}

export function writeStatus(projectId, body) {
  w(path.join(projectDir(projectId), "status.md"), `# Status\n\n_Updated ${nowIso()}_\n\n${body}\n`);
}

export function writeHandoff(projectId, { next = [], blockers = [], openQuestions = [] }) {
  const fmt = (arr) => (arr.length ? arr.map((x) => `- ${x}`).join("\n") : "- _(none)_");
  w(path.join(projectDir(projectId), "handoff.md"),
`# Handoff
_Updated ${nowIso()}_

## Next actions
${fmt(next)}

## Blockers
${fmt(blockers)}

## Open questions
${fmt(openQuestions)}
`);
}

// Mirror the task graph into tasks.md for human/agent legibility from the folder alone.
export function writeTasksFile(projectId, tasks) {
  const byStatus = {};
  for (const t of tasks) (byStatus[t.status] ||= []).push(t);
  let md = `# Tasks — ${projectId}\n\n_Mirrored ${nowIso()}_\n`;
  for (const status of ["running", "needs_approval", "pending", "claimed", "blocked", "done", "failed", "cancelled"]) {
    const items = byStatus[status];
    if (!items || !items.length) continue;
    md += `\n## ${status} (${items.length})\n`;
    for (const t of items) {
      const deps = (t.depends_on || []).length ? ` ⟵ ${t.depends_on.join(", ")}` : "";
      md += `- [${t.status === "done" ? "x" : " "}] ${t.title} \`${t.id}\` (${t.kind}, risk:${t.risk_level})${deps}\n`;
    }
  }
  w(path.join(projectDir(projectId), "tasks.md"), md);
}

export function searchKnowledge(query, limit = 20) {
  return all(
    `SELECT * FROM knowledge WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT ?`,
    `%${query}%`, `%${query}%`, limit
  );
}
