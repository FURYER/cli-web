import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout === "true";
}

/** Snapshot current worktree. Returns commit-ish or null if unavailable. */
export async function createCheckpoint(cwd: string): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null;

  await git(cwd, ["add", "-A"]);
  const created = await git(cwd, ["stash", "create"]);
  await git(cwd, ["reset", "HEAD"]);

  let sha = created.ok && created.stdout ? created.stdout : null;
  if (!sha) {
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    sha = head.ok && head.stdout ? head.stdout : null;
  }
  if (!sha) return null;

  const ref = `refs/webcli/cp/${sha.slice(0, 16)}`;
  await git(cwd, ["update-ref", ref, sha]);
  return sha;
}

/** Restore worktree (+ index) to a checkpoint without moving HEAD. */
export async function restoreCheckpoint(cwd: string, checkpoint: string): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    throw new Error("Workspace is not a git repository — cannot restore files");
  }

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

  const checkout = await git(cwd, ["checkout", checkpoint, "--", "."]);
  if (checkout.ok) {
    await git(cwd, ["clean", "-fd"]);
    return;
  }

  throw new Error(
    readTree.stderr ||
      restored.stderr ||
      checkout.stderr ||
      "Failed to restore checkpoint",
  );
}
