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

test("stale managed worktree claims exclude concurrent workspace activity", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  store.createSession({
    id: "ws_claimed",
    root: "/tmp/worktree",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });

  const future = new Date(Date.now() + 60_000);
  const claimed = store.claimStaleManagedWorktree("ws_claimed", future);
  assert.equal(claimed?.status, "pruning");
  assert.equal(store.touchSession("ws_claimed"), false);

  store.releasePruningSession("ws_claimed");
  assert.equal(store.touchSession("ws_claimed"), true);
  assert.equal(store.claimStaleManagedWorktree("ws_claimed", new Date(0)), undefined);
});
