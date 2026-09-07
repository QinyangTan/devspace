import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("workspace store lists only stale managed worktrees", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const store = new SqliteWorkspaceStore(stateDir);
  t.after(() => store.close());

  const managed = store.createSession({
    id: "ws_managed",
    root: "/tmp/managed",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });
  store.createSession({
    id: "ws_checkout",
    root: "/tmp/repo",
    mode: "checkout",
  });
  store.createSession({
    id: "ws_unmanaged",
    root: "/tmp/unmanaged",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: false,
  });

  assert.deepEqual(
    store.listStaleManagedWorktrees(new Date(Date.now() + 60_000)).map((session) => session.id),
    [managed.id],
  );
  assert.deepEqual(store.listStaleManagedWorktrees(new Date(0)), []);
});

test("deleting a workspace session cascades its conversation binding", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const store = new SqliteWorkspaceStore(stateDir);
  t.after(() => store.close());
  store.createSession({
    id: "ws_pruned",
    root: "/tmp/worktree",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });
  store.setConversationBinding({
    conversationScopeId: "conversation",
    targetKey: "target",
    workspaceSessionId: "ws_pruned",
  });

  store.deleteSession("ws_pruned");

  assert.equal(store.getSession("ws_pruned"), undefined);
  assert.equal(store.getConversationBinding("conversation", "target"), undefined);
});
