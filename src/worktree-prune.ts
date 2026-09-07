import type { ServerConfig } from "./config.js";
import {
  cleanupManagedWorktrees,
  DEFAULT_MANAGED_WORKTREE_RETENTION_MS,
  type ManagedWorktreeCleanupResult,
} from "./git-worktrees.js";
import { createWorkspaceStore } from "./workspace-store.js";

export async function pruneStaleManagedWorktrees(
  config: ServerConfig,
  now = new Date(),
): Promise<ManagedWorktreeCleanupResult> {
  const store = createWorkspaceStore(config.stateDir);
  try {
    return await cleanupManagedWorktrees({
      store,
      worktreeRoot: config.worktreeRoot,
      allowedRoots: config.allowedRoots,
      staleBefore: new Date(now.getTime() - DEFAULT_MANAGED_WORKTREE_RETENTION_MS),
    });
  } finally {
    store.close?.();
  }
}
