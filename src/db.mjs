// Operational index + coordination state. SQLite in WAL mode via node:sqlite.
// Canonical PROJECT state lives in files (projects/<id>/*.md); this DB mirrors/indexes
// for queueing, locking, events, metrics, approvals, budgets, trust, evals, visibility.
import "./quiet.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";

let _db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  description TEXT NOT NULL,
  mode TEXT,                 -- software|research|company|delivery|ops|general
  status TEXT NOT NULL DEFAULT 'open', -- open|planning|active|blocked|done|cancelled
  priority INTEGER DEFAULT 5,
  meta TEXT,                 -- json
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'command',  -- command|llm|review|research|browser|manual
  skill_tags TEXT,            -- json array
  status TEXT NOT NULL DEFAULT 'pending', -- pending|claimed|running|verifying|done|failed|blocked|cancelled|needs_approval
  depends_on TEXT,            -- json array of task ids
  priority INTEGER DEFAULT 5,
  risk_level TEXT DEFAULT 'low',
  budget_limit REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 2,
  owner TEXT,
  reviewer TEXT,
  executor TEXT,             -- which executor handled it
  verification_plan TEXT,    -- json
  evidence TEXT,             -- json array of evidence records
  artifacts TEXT,            -- json array of {path, checksum, kind}
  spec TEXT,                 -- json: kind-specific payload (run/verify/writes/prompt)
  result TEXT,               -- json: executor result summary
  escalation_reason TEXT,
  lock_owner TEXT,
  lock_at TEXT,
  depth INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  goal_id TEXT,
  project_id TEXT,
  worker TEXT,
  executor TEXT,
  status TEXT,               -- running|done|failed
  exit_code INTEGER,
  summary TEXT,
  log_path TEXT,
  cost REAL DEFAULT 0,
  tokens INTEGER DEFAULT 0,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT DEFAULT 'info',  -- info|warn|error|success
  goal_id TEXT,
  task_id TEXT,
  session_id TEXT,
  project_id TEXT,
  message TEXT,
  data TEXT                   -- json
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL,
  dims TEXT                   -- json
);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  goal_id TEXT,
  action TEXT,
  risk TEXT,
  status TEXT DEFAULT 'pending', -- pending|approved|denied|deferred
  reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  scope TEXT NOT NULL,        -- task|goal|day|month|machine
  scope_id TEXT NOT NULL,
  limit_cost REAL DEFAULT 0,
  spent_cost REAL DEFAULT 0,
  limit_tokens INTEGER DEFAULT 0,
  spent_tokens INTEGER DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS trust (
  domain TEXT PRIMARY KEY,    -- per skill/domain
  level TEXT DEFAULT 'supervised', -- supervised|guided|autonomous|trusted
  successes INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  severity TEXT,             -- sev1..sev4
  title TEXT,
  status TEXT DEFAULT 'open',
  task_id TEXT,
  goal_id TEXT,
  timeline TEXT,            -- json array
  root_cause TEXT,
  remediation TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  suite TEXT,
  total INTEGER,
  passed INTEGER,
  failed INTEGER,
  pass_rate REAL,
  meta TEXT,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS evals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  suite TEXT,
  scenario TEXT,
  status TEXT,              -- pass|fail
  score REAL,
  detail TEXT,
  ts TEXT
);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT,               -- episodic|semantic|procedural|preference|external
  key TEXT,
  value TEXT,
  provenance TEXT,
  confidence REAL DEFAULT 0.5,
  freshness TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge(kind);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  role TEXT,                -- user|assistant|system
  content TEXT,
  intent TEXT,
  meta TEXT,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, ts);

CREATE TABLE IF NOT EXISTS sagas (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,             -- running|committed|compensated|failed
  steps INTEGER,
  committed INTEGER DEFAULT 0,
  compensated INTEGER DEFAULT 0,
  failed_step INTEGER,
  error TEXT,
  ts TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY,
  saga_id TEXT,
  idempotency_key TEXT,
  kind TEXT,
  step INTEGER,
  status TEXT,             -- attempted|committed|failed|compensated|skipped
  payload TEXT,
  result TEXT,
  error TEXT,
  ts TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_effects_key ON effects(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_effects_saga ON effects(saga_id);

CREATE TABLE IF NOT EXISTS improvements (
  id TEXT PRIMARY KEY,
  name TEXT,
  hypothesis TEXT,
  baseline_pass REAL,
  after_pass REAL,
  baseline_total INTEGER,
  after_total INTEGER,
  decision TEXT,           -- kept|reverted_regression|reverted_no_gain
  error TEXT,
  ts TEXT
);

CREATE TABLE IF NOT EXISTS recurring (
  id TEXT PRIMARY KEY,
  name TEXT,
  action TEXT,              -- eval|scan|rollup
  interval_sec INTEGER,
  args TEXT,
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  last_status TEXT,
  runs INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,      -- now|next|blocked|improve|recurring
  ref_type TEXT,
  ref_id TEXT,
  title TEXT,
  priority INTEGER DEFAULT 5,
  status TEXT DEFAULT 'open',
  note TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue ON queue_items(queue, status);
`;

export function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  _db = new DatabaseSync(PATHS.db);
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA foreign_keys = ON;");
  _db.exec("PRAGMA busy_timeout = 5000;");
  _db.exec(SCHEMA);
  migrate(_db);
  return _db;
}

// Idempotent additive migrations (node:sqlite throws on duplicate column — swallow that).
function migrate(d) {
  const alters = [
    "ALTER TABLE approvals ADD COLUMN detail TEXT",      // blast-radius / what-why payload
  ];
  for (const sql of alters) {
    try { d.exec(sql); } catch { /* column already exists */ }
  }
}

// --- JSON helpers ---------------------------------------------------------
export function J(v) {
  return v == null ? null : JSON.stringify(v);
}
export function P(v, fallback = null) {
  if (v == null) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

// --- thin query helpers ---------------------------------------------------
export function run(sql, ...params) {
  return db().prepare(sql).run(...params);
}
export function get(sql, ...params) {
  return db().prepare(sql).get(...params);
}
export function all(sql, ...params) {
  return db().prepare(sql).all(...params);
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
