import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { Result, TaggedError, type Result as BetterResult } from "better-result";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import type {
  WorkspaceRecoveryKind,
  WorkspaceSession,
  WorkspaceStore,
  WorkspaceStoreError,
} from "./workspace-store.js";

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

export type ManagedWorktreeErrorCode =
  | "WORKTREE_INVALID_STATE"
  | "WORKTREE_PATH_INVALID"
  | "WORKTREE_GIT_FAILED"
  | "WORKTREE_SNAPSHOT_FAILED"
  | "WORKTREE_RESTORE_FAILED";

export class ManagedWorktreeError extends TaggedError("ManagedWorktreeError")<{
  code: ManagedWorktreeErrorCode;
  workspaceId: string;
  operation: string;
  cause?: unknown;
  message: string;
}>() {}

export type ManagedWorktreeFeatureError = ManagedWorktreeError | WorkspaceStoreError;

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
    error: ManagedWorktreeFeatureError;
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
  allowedRoots: string[];
  staleBefore: Date;
}): Promise<BetterResult<ManagedWorktreeCleanupResult, WorkspaceStoreError>> {
  const result: ManagedWorktreeCleanupResult = {
    removed: [],
    missing: [],
    skipped: [],
    failed: [],
  };

  const staleSessions = input.store.listStaleManagedWorktrees(input.staleBefore);
  if (staleSessions.isErr()) return staleSessions;

  for (const session of staleSessions.value) {
    const cleaned = await cleanupManagedWorktree({ ...input, session });
    if (cleaned.isErr()) {
      result.failed.push({
        workspaceId: session.id,
        error: cleaned.error,
      });
      continue;
    }

    switch (cleaned.value.kind) {
      case "removed":
        result.removed.push(cleaned.value.entry);
        break;
      case "missing":
        result.missing.push(session.id);
        break;
      case "skipped":
        result.skipped.push({ workspaceId: session.id, reason: "untracked_files" });
        break;
    }
  }

  return Result.ok(result);
}

export async function restoreManagedWorktree(input: {
  session: WorkspaceSession;
  worktreeRoot: string;
  allowedRoots: string[];
}): Promise<BetterResult<void, ManagedWorktreeError>> {
  const { session } = input;
  if (session.mode !== "worktree" || !session.managed || !session.sourceRoot) {
    return Result.err(worktreeError(
      session.id,
      "WORKTREE_INVALID_STATE",
      "restore",
      `Workspace ${session.id} is not a recoverable managed worktree.`,
    ));
  }
  const sourceRootPath = session.sourceRoot;

  return Result.gen(async function* () {
    const worktreePath = yield* worktreeResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "restore_path",
      () => assertAllowedPath(session.root, [input.worktreeRoot]),
    );
    const exists = yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "restore_path",
      () => isDirectory(worktreePath),
    ));
    if (exists) {
      return Result.err(worktreeError(
        session.id,
        "WORKTREE_PATH_INVALID",
        "restore_path",
        `Cannot restore workspace ${session.id} because its worktree path already exists.`,
      ));
    }

    const sourceRoot = yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "restore_source",
      () => assertCleanupSourceRootAllowed(sourceRootPath, input.allowedRoots),
    ));
    yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_RESTORE_FAILED",
      "create_worktree_root",
      () => mkdir(input.worktreeRoot, { recursive: true }).then(() => undefined),
    ));

    const recoveryRef = managedWorktreeRecoveryRef(session.id);
    const restoreRef = session.recoveryKind === "stash"
      ? `${recoveryRef}^1`
      : session.recoveryKind === "head"
        ? recoveryRef
        : session.baseSha;
    if (!restoreRef) {
      return Result.err(worktreeError(
        session.id,
        "WORKTREE_INVALID_STATE",
        "restore_ref",
        `Cannot restore workspace ${session.id} because its base commit is unknown.`,
      ));
    }

    const created = await worktreePromiseResult(
      session.id,
      "WORKTREE_RESTORE_FAILED",
      "git_worktree_add",
      () => git(["worktree", "add", "--detach", worktreePath, restoreRef], sourceRoot),
    );
    if (created.isErr()) return created;

    if (session.recoveryKind === "stash") {
      const applied = await worktreePromiseResult(
        session.id,
        "WORKTREE_RESTORE_FAILED",
        "git_stash_apply",
        () => git(["stash", "apply", "--index", recoveryRef], worktreePath),
      );
      if (applied.isErr()) {
        const discarded = await removeManagedWorktreeResult(session.id, sourceRoot, worktreePath);
        if (discarded.isErr()) {
          return Result.err(worktreeError(
            session.id,
            "WORKTREE_RESTORE_FAILED",
            "restore_compensation",
            `Failed to restore workspace ${session.id} and could not remove the partial worktree.`,
            { restore: applied.error, cleanup: discarded.error },
          ));
        }
        return applied;
      }
    }

    return Result.ok(undefined);
  });
}

export async function discardRestoredManagedWorktree(input: {
  session: WorkspaceSession;
  worktreeRoot: string;
  allowedRoots: string[];
}): Promise<BetterResult<void, ManagedWorktreeError>> {
  const { session } = input;
  if (!session.sourceRoot) {
    return Result.err(worktreeError(
      session.id,
      "WORKTREE_INVALID_STATE",
      "discard_restored",
      `Stored managed worktree is missing sourceRoot: ${session.id}`,
    ));
  }
  const sourceRootPath = session.sourceRoot;

  return Result.gen(async function* () {
    const worktreePath = yield* worktreeResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "discard_path",
      () => assertAllowedPath(session.root, [input.worktreeRoot]),
    );
    const exists = yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "discard_path",
      () => isDirectory(worktreePath),
    ));
    if (!exists) return Result.ok(undefined);

    const sourceRoot = yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "discard_source",
      () => assertCleanupSourceRootAllowed(sourceRootPath, input.allowedRoots),
    ));
    yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "discard_path",
      () => assertManagedWorktreePath(worktreePath, input.worktreeRoot),
    ));
    yield* Result.await(removeManagedWorktreeResult(session.id, sourceRoot, worktreePath));
    return Result.ok(undefined);
  });
}

type CleanupOutcome =
  | {
      kind: "removed";
      entry: ManagedWorktreeCleanupResult["removed"][number];
    }
  | { kind: "missing" }
  | { kind: "skipped" };

async function cleanupManagedWorktree(input: {
  session: WorkspaceSession;
  store: WorkspaceStore;
  worktreeRoot: string;
  allowedRoots: string[];
}): Promise<BetterResult<CleanupOutcome, ManagedWorktreeFeatureError>> {
  const { session } = input;
  return Result.gen(async function* () {
    const worktreePath = yield* worktreeResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "prune_path",
      () => assertAllowedPath(session.root, [input.worktreeRoot]),
    );
    const exists = yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "prune_path",
      () => isDirectory(worktreePath),
    ));
    if (!exists) {
      yield* input.store.deleteSession(session.id);
      return Result.ok({ kind: "missing" } as const);
    }
    if (!session.sourceRoot) {
      return Result.err(worktreeError(
        session.id,
        "WORKTREE_INVALID_STATE",
        "prune_source",
        `Stored managed worktree is missing sourceRoot: ${session.id}`,
      ));
    }
    const sourceRootPath = session.sourceRoot;

    const sourceRoot = yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "prune_source",
      () => assertCleanupSourceRootAllowed(sourceRootPath, input.allowedRoots),
    ));
    yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "prune_path",
      () => assertManagedWorktreePath(worktreePath, input.worktreeRoot),
    ));

    const status = yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_GIT_FAILED",
      "git_status",
      () => git(["status", "--porcelain=v1", "--untracked-files=normal", "--ignored=no"], worktreePath),
    ));
    if (status.split("\n").some((line) => line.startsWith("?? "))) {
      return Result.ok({ kind: "skipped" } as const);
    }

    const hasTrackedChanges = status.trim().length > 0;
    const headSha = (yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_GIT_FAILED",
      "git_rev_parse",
      () => git(["rev-parse", "HEAD"], worktreePath),
    ))).trim();
    let recoverySha: string | undefined;
    let recoveryKind: WorkspaceRecoveryKind | undefined;
    if (hasTrackedChanges) {
      recoverySha = (yield* Result.await(worktreePromiseResult(
        session.id,
        "WORKTREE_SNAPSHOT_FAILED",
        "git_stash_create",
        () => git(["stash", "create", `DevSpace recovery ${session.id}`], worktreePath),
      ))).trim();
      if (!recoverySha) {
        return Result.err(worktreeError(
          session.id,
          "WORKTREE_SNAPSHOT_FAILED",
          "git_stash_create",
          `Git could not snapshot tracked changes for ${session.id}.`,
        ));
      }
      recoveryKind = "stash";
    } else if (!session.baseSha || headSha !== session.baseSha) {
      recoverySha = headSha;
      recoveryKind = "head";
    }

    const recoveryRef = recoverySha ? managedWorktreeRecoveryRef(session.id) : undefined;
    if (recoveryRef && recoverySha) {
      yield* Result.await(worktreePromiseResult(
        session.id,
        "WORKTREE_GIT_FAILED",
        "git_update_recovery_ref",
        () => git(["update-ref", recoveryRef, recoverySha!], sourceRoot),
      ));
    }

    // Revalidate immediately before the only destructive filesystem operation.
    yield* Result.await(worktreePromiseResult(
      session.id,
      "WORKTREE_PATH_INVALID",
      "prune_path",
      () => assertManagedWorktreePath(worktreePath, input.worktreeRoot),
    ));
    yield* Result.await(removeManagedWorktreeResult(session.id, sourceRoot, worktreePath));
    yield* input.store.markSessionPruned(session.id, recoveryKind);
    return Result.ok({
      kind: "removed",
      entry: { workspaceId: session.id, recoveryRef, recoverySha },
    } as const);
  });
}

function worktreeError(
  workspaceId: string,
  code: ManagedWorktreeErrorCode,
  operation: string,
  message: string,
  cause?: unknown,
): ManagedWorktreeError {
  return new ManagedWorktreeError({ workspaceId, code, operation, message, cause });
}

function worktreeResult<T>(
  workspaceId: string,
  code: ManagedWorktreeErrorCode,
  operation: string,
  run: () => T,
): BetterResult<T, ManagedWorktreeError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(worktreeError(
      workspaceId,
      code,
      operation,
      cause instanceof Error ? cause.message : String(cause),
      cause,
    ));
  }
}

async function worktreePromiseResult<T>(
  workspaceId: string,
  code: ManagedWorktreeErrorCode,
  operation: string,
  run: () => Promise<T>,
): Promise<BetterResult<T, ManagedWorktreeError>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(worktreeError(
      workspaceId,
      code,
      operation,
      cause instanceof Error ? cause.message : String(cause),
      cause,
    ));
  }
}

function removeManagedWorktreeResult(
  workspaceId: string,
  sourceRoot: string,
  worktreePath: string,
): Promise<BetterResult<string, ManagedWorktreeError>> {
  return worktreePromiseResult(
    workspaceId,
    "WORKTREE_GIT_FAILED",
    "git_worktree_remove",
    () => git(["worktree", "remove", "--force", worktreePath], sourceRoot),
  );
}

function isProgrammerDefect(error: unknown): boolean {
  return error instanceof TypeError
    || error instanceof ReferenceError
    || error instanceof SyntaxError
    || error instanceof RangeError
    || (error instanceof Error && error.name === "AssertionError");
}

export function managedWorktreeRecoveryRef(workspaceId: string): string {
  return `refs/devspace/recovery/${workspaceId}`;
}

async function assertManagedWorktreePath(worktreePath: string, worktreeRoot: string): Promise<void> {
  const entry = await lstat(worktreePath);
  if (entry.isSymbolicLink()) {
    throw new Error(`Managed worktree path was replaced by a symbolic link: ${worktreePath}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`Managed worktree path is not a directory: ${worktreePath}`);
  }

  const [canonicalPath, canonicalRoot] = await Promise.all([
    realpath(worktreePath),
    realpath(worktreeRoot),
  ]);
  if (!isPathInsideRoot(canonicalPath, canonicalRoot)) {
    throw new Error(`Managed worktree resolves outside the configured worktree root: ${worktreePath}`);
  }
}

async function assertCleanupSourceRootAllowed(sourceRoot: string, allowedRoots: string[]): Promise<string> {
  const logicalRoot = assertAllowedPath(sourceRoot, allowedRoots);
  const canonicalSourceRoot = await realpath(logicalRoot);
  for (const allowedRoot of allowedRoots) {
    const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
    if (canonicalAllowedRoot && isPathInsideRoot(canonicalSourceRoot, canonicalAllowedRoot)) {
      return canonicalSourceRoot;
    }
  }

  throw new Error(`Stored managed worktree source resolves outside allowed roots: ${sourceRoot}`);
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
