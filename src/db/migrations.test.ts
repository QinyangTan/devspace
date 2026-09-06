import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateDatabase } from "./migrations.js";

testMigrationNameConflict();
testUnknownMigrationVersion();

console.log("database migration tests passed");

function testMigrationNameConflict(): void {
  const sqlite = migrationDatabase();
  try {
    sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    ).run(5, "workflow-journal", "2026-08-08T00:00:00.000Z");

    assert.throws(
      () => migrateDatabase(sqlite),
      /version 5 is recorded as "workflow-journal", but this build expects "local-agent-structured-errors"/,
    );
  } finally {
    sqlite.close();
  }
}

function testUnknownMigrationVersion(): void {
  const sqlite = migrationDatabase();
  try {
    sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    ).run(99, "future-migration", "2026-08-08T00:00:00.000Z");

    assert.throws(
      () => migrateDatabase(sqlite),
      /version 99 \("future-migration"\) is unknown to this build/,
    );
  } finally {
    sqlite.close();
  }
}

function migrationDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
  `);
  return sqlite;
}
