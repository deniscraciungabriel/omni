// The entity's persistent identity + its memory of the user. Files are canonical (state/), so the
// entity survives restarts and model swaps with its sense of self and what it knows about you.
import fs from "node:fs";
import path from "node:path";
import { PATHS, ENTITY_NAME, nowIso } from "../config.mjs";
import { appendKnowledge } from "../memory/memory.mjs";

const ID_FILE = path.join(PATHS.state, "entity.json");
const USER_FILE = path.join(PATHS.state, "user-profile.json");

const PERSONA =
  `I am ${ENTITY_NAME}, an agentic operating system you talk to. I turn what you ask into ` +
  `verified work: I run tasks and specialized harnesses, keep durable memory, improve myself ` +
  `behind evals, and never claim something is done without evidence. I run on a deterministic ` +
  `brain today; connect an OpenAI-compatible model and I understand free-form requests too.`;

function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function save(file, obj) {
  fs.mkdirSync(PATHS.state, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function ensureIdentity() {
  let id = load(ID_FILE, null);
  if (!id) {
    id = { name: ENTITY_NAME, born: nowIso(), persona: PERSONA, version: 1, selfNotes: [] };
    save(ID_FILE, id);
  }
  return id;
}
export function getIdentity() { return ensureIdentity(); }

// The entity records notes about its own evolution (what it learned / changed).
export function addSelfNote(note) {
  const id = ensureIdentity();
  id.selfNotes.unshift({ note, at: nowIso() });
  id.selfNotes = id.selfNotes.slice(0, 50);
  id.version++;
  save(ID_FILE, id);
  return id;
}

export function getUserProfile() {
  return load(USER_FILE, { name: null, facts: [], updated: null });
}

export function setUserName(name) {
  const p = getUserProfile();
  p.name = name; p.updated = nowIso();
  save(USER_FILE, p);
  return p;
}

// Durable preference memory: remembered in the user profile AND the searchable knowledge index.
export function rememberAboutUser(fact, projectId = "entity") {
  const p = getUserProfile();
  const norm = fact.trim().toLowerCase();
  if (p.facts.some((f) => f.fact.trim().toLowerCase() === norm)) return p; // dedupe exact repeats
  p.facts.unshift({ fact, at: nowIso() });
  p.facts = p.facts.slice(0, 200);
  p.updated = nowIso();
  save(USER_FILE, p);
  try { appendKnowledge(projectId, { kind: "preference", key: `pref:${Date.now().toString(36)}`, value: fact, confidence: 0.8, provenance: "user told me" }); } catch { /* entity project may not exist yet */ }
  return p;
}
