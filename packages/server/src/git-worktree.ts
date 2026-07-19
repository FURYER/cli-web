import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { dataDir, WORKSPACE_META_DIR } from "./paths.js";
import { isGitRepo } from "./git-checkpoint.js";

const execFileAsync = promisify(execFile);

/** Always-on git flags so Windows worktrees survive paths > 260 chars. */
const LONGPATH_ARGS = ["-c", "core.longpaths=true"] as const;

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      [...LONGPATH_ARGS, ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? error.message ?? "").trim(),
    };
  }
}

/** Persist longpaths on the repo so plain `git` (hooks, GUIs) also works. */
async function ensureRepoLongPaths(cwd: string): Promise<void> {
  await git(cwd, ["config", "core.longpaths", "true"]);
}

function shortId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9]/g, "");
  return (cleaned || id).slice(0, 8);
}

/**
 * Optional per-project excludes for child worktrees:
 * `.webcli/worktree-excludes` — one repo-relative directory per line
 * (e.g. `universal-lpc-spritesheet-character-generator`).
 * Speeds up forks of huge trees and avoids Windows MAX_PATH failures.
 */
async function readWorktreeExcludes(parentWorkspace: string): Promise<string[]> {
  const file = join(parentWorkspace, WORKSPACE_META_DIR, "worktree-excludes");
  try {
    const text = await readFile(file, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .map((line) => line.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
  } catch {
    return [];
  }
}

export type ChildWorktree = {
  worktreePath: string;
  branch: string;
  baseSha: string;
};

export type DelegatePrepareResult =
  | {
      ok: true;
      headSha: string;
      checkpointCreated: boolean;
      filesCommitted: number;
      message: string;
    }
  | {
      ok: false;
      error: string;
      code?: "not_git" | "busy" | "commit_failed";
    };

/**
 * Absolute path for an isolated agent worktree (outside the project tree).
 * Short ids keep Windows paths under classic MAX_PATH when possible.
 */
export function childWorktreePath(parentSessionId: string, childSessionId: string): string {
  return join(dataDir(), "wt", shortId(parentSessionId), shortId(childSessionId));
}

export function childBranchName(childSessionId: string): string {
  return `webcli/agent/${childSessionId.slice(0, 8)}`;
}

async function gitBusyOperation(cwd: string): Promise<string | null> {
  for (const [ref, label] of [
    ["MERGE_HEAD", "merge"],
    ["REBASE_HEAD", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ] as const) {
    const r = await git(cwd, ["rev-parse", "-q", "--verify", ref]);
    if (r.ok && r.stdout) return label;
  }
  return null;
}

/**
 * Ensure the parent workspace is safe to fork into child worktrees.
 * Dirty tree → automatic checkpoint commit so children see current files
 * and merge will not collide with untracked paths.
 */
export async function prepareParentForDelegate(
  cwd: string,
): Promise<DelegatePrepareResult> {
  if (!(await isGitRepo(cwd))) {
    return {
      ok: false,
      code: "not_git",
      error:
        "Parent workspace is not a git repository — init git (and commit the project) before delegating",
    };
  }

  const busy = await gitBusyOperation(cwd);
  if (busy) {
    return {
      ok: false,
      code: "busy",
      error: `Cannot delegate during an in-progress ${busy}. Finish or abort it first.`,
    };
  }

  await ensureRepoLongPaths(cwd);
  await git(cwd, ["worktree", "prune"]);

  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status.ok) {
    return {
      ok: false,
      code: "commit_failed",
      error: status.stderr || "git status failed",
    };
  }

  const dirtyLines = status.stdout
    ? status.stdout.split(/\r?\n/).filter(Boolean)
    : [];

  if (dirtyLines.length === 0) {
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    if (!head.ok || !head.stdout) {
      return {
        ok: false,
        code: "commit_failed",
        error: head.stderr || "Could not resolve HEAD (empty repo? make an initial commit)",
      };
    }
    return {
      ok: true,
      headSha: head.stdout,
      checkpointCreated: false,
      filesCommitted: 0,
      message: "Workspace already clean for delegate",
    };
  }

  const add = await git(cwd, ["add", "-A"]);
  if (!add.ok) {
    return {
      ok: false,
      code: "commit_failed",
      error: add.stderr || "git add -A failed before delegate checkpoint",
    };
  }

  // Local -c identity so hosts without user.name/email still checkpoint.
  const commit = await git(cwd, [
    "-c",
    "user.email=webcli@localhost",
    "-c",
    "user.name=WebCLI",
    "commit",
    "-m",
    "webcli: checkpoint before delegate",
  ]);

  if (!commit.ok) {
    const combined = `${commit.stdout}\n${commit.stderr}`;
    if (/nothing to commit/i.test(combined)) {
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      if (!head.ok || !head.stdout) {
        return {
          ok: false,
          code: "commit_failed",
          error: head.stderr || "Could not resolve HEAD after empty checkpoint",
        };
      }
      return {
        ok: true,
        headSha: head.stdout,
        checkpointCreated: false,
        filesCommitted: 0,
        message: "Workspace already clean for delegate",
      };
    }
    return {
      ok: false,
      code: "commit_failed",
      error:
        commit.stderr ||
        commit.stdout ||
        "Failed to create checkpoint commit before delegate",
    };
  }

  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) {
    return {
      ok: false,
      code: "commit_failed",
      error: head.stderr || "Checkpoint commit succeeded but HEAD is missing",
    };
  }

  return {
    ok: true,
    headSha: head.stdout,
    checkpointCreated: true,
    filesCommitted: dirtyLines.length,
    message: `Created checkpoint commit (${dirtyLines.length} path(s)) so sub-agents see current files`,
  };
}

/**
 * Create a new branch + worktree from the parent's HEAD.
 * Call {@link prepareParentForDelegate} first so HEAD includes current work.
 * Worktree lives under the host data dir so the project stays clean.
 */
export async function createChildWorktree(input: {
  parentWorkspace: string;
  parentSessionId: string;
  childSessionId: string;
}): Promise<ChildWorktree> {
  const cwd = input.parentWorkspace;
  if (!(await isGitRepo(cwd))) {
    throw new Error("Parent workspace is not a git repository — cannot create agent worktree");
  }

  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) {
    throw new Error(head.stderr || "Could not resolve HEAD for worktree");
  }

  await ensureRepoLongPaths(cwd);

  const branch = childBranchName(input.childSessionId);
  const worktreePath = childWorktreePath(input.parentSessionId, input.childSessionId);
  await mkdir(dirname(worktreePath), { recursive: true });

  // Remove stale worktree/branch if a previous run crashed.
  await git(cwd, ["worktree", "prune"]);
  const existing = await git(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]);
  if (existing.ok) {
    await git(cwd, ["worktree", "remove", "--force", worktreePath]);
    await git(cwd, ["branch", "-D", branch]);
  }

  const excludes = await readWorktreeExcludes(cwd);
  const addArgs = excludes.length
    ? (["worktree", "add", "--no-checkout", "-b", branch, worktreePath, head.stdout] as string[])
    : (["worktree", "add", "-b", branch, worktreePath, head.stdout] as string[]);

  const added = await git(cwd, addArgs);
  if (!added.ok) {
    throw new Error(added.stderr || added.stdout || "git worktree add failed");
  }

  if (excludes.length) {
    // Non-cone: include everything, then negate huge vendor trees.
    const patterns = ["/*", ...excludes.map((dir) => `!/${dir}/`)];
    const sparseInit = await git(worktreePath, ["sparse-checkout", "init", "--no-cone"]);
    if (!sparseInit.ok) {
      await git(cwd, ["worktree", "remove", "--force", worktreePath]);
      await git(cwd, ["branch", "-D", branch]);
      throw new Error(sparseInit.stderr || "sparse-checkout init failed");
    }
    const sparseSet = await git(worktreePath, ["sparse-checkout", "set", "--no-cone", ...patterns]);
    if (!sparseSet.ok) {
      await git(cwd, ["worktree", "remove", "--force", worktreePath]);
      await git(cwd, ["branch", "-D", branch]);
      throw new Error(sparseSet.stderr || "sparse-checkout set failed");
    }
    const checked = await git(worktreePath, ["checkout", head.stdout]);
    if (!checked.ok) {
      await git(cwd, ["worktree", "remove", "--force", worktreePath]);
      await git(cwd, ["branch", "-D", branch]);
      throw new Error(checked.stderr || checked.stdout || "sparse worktree checkout failed");
    }
    await ensureRepoLongPaths(worktreePath);
  }

  return { worktreePath, branch, baseSha: head.stdout };
}

export type MergeChildResult = {
  ok: boolean;
  conflict: boolean;
  message: string;
  mergedSha?: string;
};

/**
 * Merge the child branch into the parent workspace (current branch), then drop the worktree.
 * On conflict: leaves the conflict in the parent index for the orchestrator / user to resolve;
 * does not remove the worktree so the child branch remains available.
 */
export async function mergeChildIntoParent(input: {
  parentWorkspace: string;
  branch: string;
  worktreePath: string;
  /** Delete the branch after a clean merge. Default true. */
  deleteBranch?: boolean;
}): Promise<MergeChildResult> {
  const cwd = input.parentWorkspace;
  if (!(await isGitRepo(cwd))) {
    throw new Error("Parent workspace is not a git repository");
  }

  // Commit any leftover conflict state would be dangerous — require clean or allow merge with strategy.
  const merge = await git(cwd, ["merge", "--no-ff", "-m", `webcli: merge ${input.branch}`, input.branch]);
  if (!merge.ok) {
    const conflicted = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
    const files = conflicted.stdout
      ? conflicted.stdout.split(/\r?\n/).filter(Boolean)
      : [];
    return {
      ok: false,
      conflict: files.length > 0 || /conflict/i.test(merge.stderr + merge.stdout),
      message:
        files.length > 0
          ? `Merge conflict in: ${files.join(", ")}`
          : merge.stderr || merge.stdout || "Merge failed",
    };
  }

  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  await removeChildWorktree({
    parentWorkspace: cwd,
    worktreePath: input.worktreePath,
    branch: input.branch,
    deleteBranch: input.deleteBranch !== false,
  });

  return {
    ok: true,
    conflict: false,
    message: `Merged ${input.branch}`,
    mergedSha: sha.ok ? sha.stdout : undefined,
  };
}

export async function removeChildWorktree(input: {
  parentWorkspace: string;
  worktreePath: string;
  branch?: string;
  deleteBranch?: boolean;
}): Promise<void> {
  const cwd = input.parentWorkspace;
  await git(cwd, ["worktree", "remove", "--force", input.worktreePath]);
  await git(cwd, ["worktree", "prune"]);
  if (input.deleteBranch && input.branch) {
    await git(cwd, ["branch", "-D", input.branch]);
  }
}

/** Last commit message + short stat on the child branch (for orchestrator review). */
export async function summarizeChildBranch(input: {
  parentWorkspace: string;
  branch: string;
  baseSha: string;
}): Promise<string> {
  const cwd = input.parentWorkspace;
  const log = await git(cwd, [
    "log",
    "--oneline",
    `${input.baseSha}..${input.branch}`,
  ]);
  const stat = await git(cwd, [
    "diff",
    "--stat",
    `${input.baseSha}...${input.branch}`,
  ]);
  const parts = [
    log.ok && log.stdout ? `Commits:\n${log.stdout}` : "Commits: (none)",
    stat.ok && stat.stdout ? `Diff:\n${stat.stdout}` : "",
  ].filter(Boolean);
  return parts.join("\n\n") || "(no changes on branch)";
}

export async function abortMerge(parentWorkspace: string): Promise<void> {
  await git(parentWorkspace, ["merge", "--abort"]);
}
