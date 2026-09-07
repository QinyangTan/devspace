import { and, eq, gt, lt, or } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceConversationBindings,
  workspaceSessions,
  type WorkspaceConversationBindingRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  listStaleManagedWorktrees(before: Date, now?: Date): WorkspaceSession[];
  claimStaleManagedWorktree(input: {
    id: string;
    before: Date;
    now: Date;
    owner: string;
    expiresAt: Date;
  }): WorkspaceSession | undefined;
  renewPruningSession(id: string, owner: string, now: Date, expiresAt: Date): boolean;
  releasePruningSession(id: string, owner: string): void;
  deletePruningSession(id: string, owner: string): boolean;
  touchSession(id: string): boolean;
  deleteSession(id: string): void;
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  listStaleManagedWorktrees(before: Date, now = new Date()): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(
        and(
          eq(workspaceSessions.mode, "worktree"),
          eq(workspaceSessions.managed, "true"),
          or(
            and(
              eq(workspaceSessions.status, "active"),
              lt(workspaceSessions.lastUsedAt, before.toISOString()),
            ),
            and(
              eq(workspaceSessions.status, "pruning"),
              lt(workspaceSessions.pruneClaimExpiresAt, now.toISOString()),
            ),
          ),
        ),
      )
      .all()
      .map(rowToWorkspaceSession);
  }

  claimStaleManagedWorktree(input: {
    id: string;
    before: Date;
    now: Date;
    owner: string;
    expiresAt: Date;
  }): WorkspaceSession | undefined {
    const row = this.database.db
      .update(workspaceSessions)
      .set({
        status: "pruning",
        pruneClaimOwner: input.owner,
        pruneClaimExpiresAt: input.expiresAt.toISOString(),
      })
      .where(
        and(
          eq(workspaceSessions.id, input.id),
          eq(workspaceSessions.mode, "worktree"),
          eq(workspaceSessions.managed, "true"),
          or(
            and(
              eq(workspaceSessions.status, "active"),
              lt(workspaceSessions.lastUsedAt, input.before.toISOString()),
            ),
            and(
              eq(workspaceSessions.status, "pruning"),
              lt(workspaceSessions.pruneClaimExpiresAt, input.now.toISOString()),
            ),
          ),
        ),
      )
      .returning()
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  renewPruningSession(id: string, owner: string, now: Date, expiresAt: Date): boolean {
    const result = this.database.db
      .update(workspaceSessions)
      .set({ pruneClaimExpiresAt: expiresAt.toISOString() })
      .where(
        and(
          eq(workspaceSessions.id, id),
          eq(workspaceSessions.status, "pruning"),
          eq(workspaceSessions.pruneClaimOwner, owner),
          gt(workspaceSessions.pruneClaimExpiresAt, now.toISOString()),
        ),
      )
      .run();
    return result.changes > 0;
  }

  releasePruningSession(id: string, owner: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({
        status: "active",
        pruneClaimOwner: null,
        pruneClaimExpiresAt: null,
      })
      .where(
        and(
          eq(workspaceSessions.id, id),
          eq(workspaceSessions.status, "pruning"),
          eq(workspaceSessions.pruneClaimOwner, owner),
        ),
      )
      .run();
  }

  deletePruningSession(id: string, owner: string): boolean {
    const result = this.database.db
      .delete(workspaceSessions)
      .where(
        and(
          eq(workspaceSessions.id, id),
          eq(workspaceSessions.status, "pruning"),
          eq(workspaceSessions.pruneClaimOwner, owner),
        ),
      )
      .run();
    return result.changes > 0;
  }

  touchSession(id: string): boolean {
    const result = this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceSessions.id, id),
          eq(workspaceSessions.status, "active"),
        ),
      )
      .run();
    return result.changes > 0;
  }

  deleteSession(id: string): void {
    this.database.db
      .delete(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeId: input.conversationScopeId,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeId,
          workspaceConversationBindings.targetKey,
        ],
        set: {
          workspaceSessionId: input.workspaceSessionId,
          lastUsedAt: now,
        },
      })
      .returning()
      .get();

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .update(workspaceConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
