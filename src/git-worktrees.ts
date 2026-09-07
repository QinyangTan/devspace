import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import type { WorkspaceStore } from "./workspace-store.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export const DEFAULT_MANAGED_WORKTREE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export interface ManagedWorktreeCleanupResult {
  removed: Array<{
    workspaceId: string;
    recoveryRef?: string;
    recoverySha?: string;
  }>;
  missing: string[];
  skipped: Array<{
    workspaceId: string;
    reason: "untracked_files";
  }>;
  failed: Array<{
    workspaceId: string;
    error: string;
  }>;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await git(["worktree", "add", "--detach", worktreePath, baseSha], sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
}

export async function cleanupManagedWorktrees(input: {
  store: WorkspaceStore;
  worktreeRoot: string;
  staleBefore: Date;
}): Promise<ManagedWorktreeCleanupResult> {
  const result: ManagedWorktreeCleanupResult = {
    removed: [],
    missing: [],
    skipped: [],
    failed: [],
  };

  for (const session of input.store.listStaleManagedWorktrees(input.staleBefore)) {
    try {
      const worktreePath = assertAllowedPath(session.root, [input.worktreeRoot]);
      if (!(await isDirectory(worktreePath))) {
        input.store.deleteSession(session.id);
        result.missing.push(session.id);
        continue;
      }
      if (!session.sourceRoot) {
        throw new Error(`Stored managed worktree is missing sourceRoot: ${session.id}`);
      }

      const status = await git(
        ["status", "--porcelain=v1", "--untracked-files=normal", "--ignored=no"],
        worktreePath,
      );
      if (status.split("\n").some((line) => line.startsWith("?? "))) {
        result.skipped.push({ workspaceId: session.id, reason: "untracked_files" });
        continue;
      }

      const hasTrackedChanges = status.trim().length > 0;
      const headSha = (await git(["rev-parse", "HEAD"], worktreePath)).trim();
      let recoverySha: string | undefined;
      if (hasTrackedChanges) {
        recoverySha = (await git(
          ["stash", "create", `DevSpace recovery ${session.id}`],
          worktreePath,
        )).trim();
        if (!recoverySha) {
          throw new Error(`Git could not snapshot tracked changes for ${session.id}.`);
        }
      } else if (!session.baseSha || headSha !== session.baseSha) {
        recoverySha = headSha;
      }

      const recoveryRef = recoverySha ? managedWorktreeRecoveryRef(session.id) : undefined;
      if (recoveryRef && recoverySha) {
        await git(["update-ref", recoveryRef, recoverySha], session.sourceRoot);
      }

      if (hasTrackedChanges) {
        await git(["reset", "--hard", "HEAD"], worktreePath);
      }
      // Ignored files are reproducible worktree-local state (dependencies, build output, caches).
      await git(["clean", "-fdX"], worktreePath);
      await git(["worktree", "remove", worktreePath], session.sourceRoot);
      input.store.deleteSession(session.id);
      result.removed.push({ workspaceId: session.id, recoveryRef, recoverySha });
    } catch (error) {
      result.failed.push({
        workspaceId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export function managedWorktreeRecoveryRef(workspaceId: string): string {
  return `refs/devspace/recovery/${workspaceId}`;
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const worktreeId = randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
