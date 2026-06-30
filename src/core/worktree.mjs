// Git worktree isolation for parallel/risky coding work. Each coding task gets its own branch +
// working dir so agents never mutate a shared checkout. On success the branch is squash-merged
// back into the sandbox repo's main tree; the diff is captured as evidence.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// Ensure `dir` is its OWN git repo with at least one commit (worktrees require a HEAD).
// Critical: if `dir` only sits *inside* an ambient repo (e.g. the omni root), we must still
// create a dedicated nested repo here — otherwise worktrees/commits would pollute the parent.
export function ensureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const top = git(["rev-parse", "--show-toplevel"], dir);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const isOwnRepo = top.status === 0 && real(top.stdout.trim()) === real(dir);
  if (!isOwnRepo) {
    git(["init", "-q"], dir); // nested repo: the inner .git takes precedence for this subtree
    git(["config", "user.email", "omni@local"], dir);
    git(["config", "user.name", "omni"], dir);
  }
  if (git(["rev-parse", "HEAD"], dir).status !== 0) {
    fs.writeFileSync(path.join(dir, ".omni-keep"), "omni sandbox repo\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "omni: init sandbox"], dir);
  }
  return dir;
}

export function defaultBranch(dir) {
  const r = git(["symbolic-ref", "--short", "HEAD"], dir);
  return r.status === 0 ? r.stdout.trim() : "master";
}

// Create an isolated worktree on branch omni/<name>. Returns { wtPath, branch }.
export function addWorktree(repoDir, name) {
  ensureRepo(repoDir);
  const wtPath = path.join(repoDir, ".worktrees", name);
  const branch = `omni/${name}`;
  // clean any stale worktree/branch with this name
  git(["worktree", "remove", "--force", wtPath], repoDir);
  git(["branch", "-D", branch], repoDir);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const r = git(["worktree", "add", "-b", branch, wtPath, "HEAD"], repoDir);
  if (r.status !== 0) throw new Error("worktree add failed: " + (r.stderr || r.stdout));
  return { wtPath, branch };
}

// Stage everything in the worktree and return the diff (evidence of what the agent changed).
export function captureDiff(wtPath) {
  git(["add", "-A"], wtPath);
  const stat = (git(["diff", "--cached", "--stat"], wtPath).stdout || "").trim();
  const diff = git(["diff", "--cached"], wtPath).stdout || "";
  const files = (git(["diff", "--cached", "--name-only"], wtPath).stdout || "")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  return { stat, diff, files };
}

export function commitWorktree(wtPath, msg) {
  git(["add", "-A"], wtPath);
  return git(["commit", "-q", "-m", msg], wtPath).status === 0;
}

// Squash-merge the branch into the sandbox repo's main working tree, then drop the worktree.
export function integrateWorktree(repoDir, branch, wtPath, msg) {
  commitWorktree(wtPath, msg || `omni: work on ${branch}`);
  const merge = git(["merge", "--squash", branch], repoDir);
  let ok = merge.status === 0;
  if (ok) {
    const commit = git(["commit", "-q", "-m", msg || `omni: integrate ${branch}`], repoDir);
    ok = commit.status === 0 || /nothing to commit/.test(commit.stdout + commit.stderr);
  }
  removeWorktree(repoDir, wtPath);
  git(["branch", "-D", branch], repoDir);
  return ok;
}

export function removeWorktree(repoDir, wtPath) {
  git(["worktree", "remove", "--force", wtPath], repoDir);
}
