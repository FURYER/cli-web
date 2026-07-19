/**
 * Smoke-test git worktree create → edit → merge → cleanup.
 * Run: npx tsx scripts/test-worktree.mts
 */
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createChildWorktree,
  mergeChildIntoParent,
  prepareParentForDelegate,
  removeChildWorktree,
  summarizeChildBranch,
} from "../packages/server/src/git-worktree.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "webcli-wt-"));
  const parentId = "parent-test";
  const childId = "child-abcd1234-ffff-ffff-ffff-ffffffffffff";

  console.log("temp repo:", root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@webcli.local"]);
  await git(root, ["config", "user.name", "WebCLI Test"]);
  await writeFile(join(root, "README.md"), "# test\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "init"]);

  // Point dataDir via env so worktrees land in a known place
  process.env.WEBCLI_DATA_DIR = join(root, ".webcli-data");
  await mkdir(process.env.WEBCLI_DATA_DIR, { recursive: true });

  // Dirty parent → prepare creates checkpoint so child sees the file
  await writeFile(join(root, "untracked-prep.txt"), "prep me\n", "utf8");
  const prepDirty = await prepareParentForDelegate(root);
  console.log("prepare dirty:", prepDirty);
  if (!prepDirty.ok || !prepDirty.checkpointCreated) {
    throw new Error("expected checkpoint commit for dirty tree");
  }
  if (!(await readFile(join(root, "untracked-prep.txt"), "utf8")).includes("prep")) {
    throw new Error("prep file missing after checkpoint");
  }
  const prepClean = await prepareParentForDelegate(root);
  console.log("prepare clean:", prepClean);
  if (!prepClean.ok || prepClean.checkpointCreated) {
    throw new Error("expected no-op prepare on clean tree");
  }

  const wt = await createChildWorktree({
    parentWorkspace: root,
    parentSessionId: parentId,
    childSessionId: childId,
  });
  console.log("worktree:", wt);

  // Child must see the checkpointed file
  const seen = await readFile(join(wt.worktreePath, "untracked-prep.txt"), "utf8");
  if (!seen.includes("prep me")) {
    throw new Error("child worktree missing checkpointed file");
  }
  console.log("OK: child sees prepared file");

  await writeFile(join(wt.worktreePath, "feature.txt"), "hello from child\n", "utf8");
  await git(wt.worktreePath, ["add", "."]);
  await git(wt.worktreePath, ["commit", "-m", "child change"]);

  const summary = await summarizeChildBranch({
    parentWorkspace: root,
    branch: wt.branch,
    baseSha: wt.baseSha,
  });
  console.log("summary:\n", summary);
  if (!summary.includes("feature.txt") && !summary.includes("child")) {
    throw new Error("expected branch summary to mention child commit");
  }

  const merged = await mergeChildIntoParent({
    parentWorkspace: root,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
  });
  console.log("merge:", merged);
  if (!merged.ok || merged.conflict) throw new Error("merge failed: " + merged.message);

  const content = await readFile(join(root, "feature.txt"), "utf8");
  if (content.trim() !== "hello from child") {
    throw new Error("parent missing merged file content: " + content);
  }
  console.log("OK: file merged into parent");

  // Conflict scenario
  const childId2 = "child-bbbbbbbb-ffff-ffff-ffff-ffffffffffff";
  await writeFile(join(root, "clash.txt"), "parent version\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "parent clash"]);

  const wt2 = await createChildWorktree({
    parentWorkspace: root,
    parentSessionId: parentId,
    childSessionId: childId2,
  });
  await writeFile(join(wt2.worktreePath, "clash.txt"), "child version\n", "utf8");
  await git(wt2.worktreePath, ["add", "."]);
  await git(wt2.worktreePath, ["commit", "-m", "child clash"]);

  // diverge parent further
  await writeFile(join(root, "clash.txt"), "parent version 2\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "parent clash 2"]);

  const conflict = await mergeChildIntoParent({
    parentWorkspace: root,
    branch: wt2.branch,
    worktreePath: wt2.worktreePath,
  });
  console.log("conflict merge:", conflict);
  if (!conflict.conflict) {
    await removeChildWorktree({
      parentWorkspace: root,
      worktreePath: wt2.worktreePath,
      branch: wt2.branch,
      deleteBranch: true,
    }).catch(() => undefined);
    throw new Error("expected a merge conflict");
  }
  console.log("OK: conflict detected as expected");

  await git(root, ["merge", "--abort"]).catch(() => undefined);
  await removeChildWorktree({
    parentWorkspace: root,
    worktreePath: wt2.worktreePath,
    branch: wt2.branch,
    deleteBranch: true,
  }).catch(() => undefined);

  await rm(root, { recursive: true, force: true });
  console.log("\nAll worktree tests passed.");
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
