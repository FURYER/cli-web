import { execFile } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Serialize checkpoint/restore per git root (avoids concurrent index.lock). */
const repoChains = new Map<string, Promise<unknown>>();

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
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

function isIndexLockError(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("index.lock") || t.includes("unable to create");
}

async function gitRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.stdout) return null;
  return result.stdout.replace(/\\/g, "/");
}

function indexLockPath(repoRoot: string): string {
  return join(repoRoot, ".git", "index.lock");
}

/**
 * Remove a leftover index.lock when it looks abandoned (no fresh writer).
 * Concurrent live git still racing is handled by retries + in-process queue.
 */
function clearStaleIndexLock(repoRoot: string, maxAgeMs = 8_000): boolean {
  const lock = indexLockPath(repoRoot);
  if (!existsSync(lock)) return false;
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < maxAgeMs) return false;
    unlinkSync(lock);
    console.warn(
      `[git-checkpoint] removed stale index.lock in ${repoRoot} (age ${Math.round(age / 1000)}s)`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[git-checkpoint] could not clear index.lock:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function withRepoQueue<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const root = (await gitRoot(cwd)) ?? cwd.replace(/\\/g, "/");
  const key = root.toLowerCase();
  const prev = repoChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => hold);
  repoChains.set(
    key,
    tail.catch(() => undefined),
  );
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (repoChains.get(key) === tail) repoChains.delete(key);
  }
}

async function withIndexLockRetry<T>(
  cwd: string,
  fn: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  const root = (await gitRoot(cwd)) ?? cwd;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isIndexLockError(msg) || i === attempts - 1) throw err;
      // Prefer waiting for a live writer; then clear if still stuck.
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      if (i >= 2) clearStaleIndexLock(root, 2_000);
      else clearStaleIndexLock(root, 15_000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout === "true";
}

/** Snapshot current worktree. Returns commit-ish or null if unavailable. */
export async function createCheckpoint(cwd: string): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null;

  return withRepoQueue(cwd, () =>
    withIndexLockRetry(cwd, async () => {
      const root = (await gitRoot(cwd)) ?? cwd;
      clearStaleIndexLock(root, 30_000);

      const add = await git(cwd, ["add", "-A"]);
      if (!add.ok && isIndexLockError(add.stderr)) {
        throw new Error(add.stderr);
      }

      const created = await git(cwd, ["stash", "create"]);
      const reset = await git(cwd, ["reset", "HEAD"]);
      if (!reset.ok && isIndexLockError(reset.stderr)) {
        throw new Error(reset.stderr);
      }

      let sha = created.ok && created.stdout ? created.stdout : null;
      if (!sha) {
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        sha = head.ok && head.stdout ? head.stdout : null;
      }
      if (!sha) return null;

      const ref = `refs/webcli/cp/${sha.slice(0, 16)}`;
      await git(cwd, ["update-ref", ref, sha]);
      return sha;
    }),
  );
}

/** Restore worktree (+ index) to a checkpoint without moving HEAD. */
export async function restoreCheckpoint(cwd: string, checkpoint: string): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    throw new Error("Workspace is not a git repository — cannot restore files");
  }

  await withRepoQueue(cwd, () =>
    withIndexLockRetry(cwd, async () => {
      const root = (await gitRoot(cwd)) ?? cwd;
      clearStaleIndexLock(root, 30_000);

      const kind = await git(cwd, ["cat-file", "-t", checkpoint]);
      if (!kind.ok) {
        throw new Error(
          `Checkpoint ${checkpoint.slice(0, 12)} is missing from git (object not found)`,
        );
      }

      const tree = await git(cwd, ["rev-parse", `${checkpoint}^{tree}`]);
      if (!tree.ok || !tree.stdout) {
        throw new Error(
          `Could not resolve checkpoint tree: ${tree.stderr || checkpoint.slice(0, 12)}`,
        );
      }

      const readTree = await git(cwd, ["read-tree", "-u", "--reset", tree.stdout]);
      if (readTree.ok) {
        await git(cwd, ["clean", "-fd"]);
        return;
      }
      if (isIndexLockError(readTree.stderr)) {
        throw new Error(readTree.stderr);
      }

      const restored = await git(cwd, [
        "restore",
        "--source",
        checkpoint,
        "--staged",
        "--worktree",
        ".",
      ]);
      if (restored.ok) {
        await git(cwd, ["clean", "-fd"]);
        return;
      }
      if (isIndexLockError(restored.stderr)) {
        throw new Error(restored.stderr);
      }

      const checkout = await git(cwd, ["checkout", checkpoint, "--", "."]);
      if (checkout.ok) {
        await git(cwd, ["clean", "-fd"]);
        return;
      }
      if (isIndexLockError(checkout.stderr)) {
        throw new Error(checkout.stderr);
      }

      throw new Error(
        readTree.stderr ||
          restored.stderr ||
          checkout.stderr ||
          "Failed to restore checkpoint",
      );
    }),
  );
}
