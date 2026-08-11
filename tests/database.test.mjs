import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { backupDatabase, restoreDatabase } from "../db/maintenance.mjs";
import { seedDevelopmentData } from "../db/seed.mjs";
import { REQUIRED_APPLICATION_TABLES, applyMigrations, inspectDatabase, openDatabase } from "../db/sqlite.mjs";

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-schedule-db-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("applies the SQLite migration and creates every required table", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = resolve(directory, "test.sqlite");
    const database = openDatabase(databasePath);
    try {
      const first = await applyMigrations(database);
      const second = await applyMigrations(database);
      const report = inspectDatabase(database);
      assert.ok(first.applied.length >= 1);
      assert.equal(second.applied.length, 0);
      assert.equal(report.integrityOk, true);
      assert.equal(report.foreignKeysOk, true);
      assert.deepEqual(report.missingTables, []);
      REQUIRED_APPLICATION_TABLES.forEach((name) => assert.ok(report.tables.includes(name), name));
    } finally {
      database.close();
    }
  });
});

test("seeds only explicit fictional records and remains idempotent", async () => {
  await withTemporaryDirectory(async (directory) => {
    const database = openDatabase(resolve(directory, "seed.sqlite"));
    try {
      await applyMigrations(database);
      seedDevelopmentData(database, new Date("2099-01-01T00:00:00.000Z"));
      seedDevelopmentData(database, new Date("2099-01-02T00:00:00.000Z"));

      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM families").get().count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM children").get().count, 2);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_children").get().count, 2);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standard_reasons").get().count, 4);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM basic_usage_patterns").get().count, 12);
      const family = database.prepare("SELECT family_code, display_name FROM families").get();
      assert.equal(family.family_code, "DEMO-FAMILY-001");
      assert.match(family.display_name, /架空/);
      assert.equal(database.prepare("SELECT password_hash FROM family_accounts").get().password_hash, null);
      assert.equal(database.prepare("SELECT password_hash FROM administrators").get().password_hash, null);
    } finally {
      database.close();
    }
  });
});

test("backs up and restores an explicitly selected SQLite file with a pre-restore backup", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = resolve(directory, "active.sqlite");
    const backupDirectory = resolve(directory, "backups");
    let database = openDatabase(databasePath);
    await applyMigrations(database);
    seedDevelopmentData(database, new Date("2099-01-01T00:00:00.000Z"));
    database.close();

    const manualBackup = await backupDatabase({
      databasePath,
      backupDirectory,
      now: new Date(2099, 1, 3, 4, 5, 6, 7),
    });
    assert.match(manualBackup, /20990203-040506-007_manual-backup\.sqlite$/);
    await access(manualBackup);

    database = openDatabase(databasePath);
    database.prepare("UPDATE families SET display_name = ? WHERE id = ?").run("復元前の変更", "demo-family-001");
    database.close();

    const restored = await restoreDatabase({
      databasePath,
      sourcePath: manualBackup,
      backupDirectory,
      now: new Date(2099, 1, 3, 4, 6, 0, 8),
    });
    assert.ok(restored.preRestoreBackupPath);
    assert.match(restored.preRestoreBackupPath, /20990203-040600-008_pre-restore\.sqlite$/);

    const restoredDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(restoredDatabase.prepare("SELECT display_name FROM families WHERE id = ?").get("demo-family-001").display_name, "架空テスト家庭A");
    restoredDatabase.close();

    const preRestoreDatabase = new DatabaseSync(restored.preRestoreBackupPath, { readOnly: true });
    assert.equal(preRestoreDatabase.prepare("SELECT display_name FROM families WHERE id = ?").get("demo-family-001").display_name, "復元前の変更");
    preRestoreDatabase.close();
    assert.ok((await readFile(manualBackup)).length > 0);
  });
});

test("rejects restore when the source file is not explicitly provided", async () => {
  await assert.rejects(
    restoreDatabase({ databasePath: resolve(tmpdir(), "not-created.sqlite") }),
    /--file/,
  );
});
