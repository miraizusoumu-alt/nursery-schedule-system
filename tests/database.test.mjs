import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { backupDatabase, restoreDatabase } from "../db/maintenance.mjs";
import { seedDevelopmentData } from "../db/seed.mjs";
import {
  PROJECT_ROOT,
  REQUIRED_APPLICATION_TABLES,
  VERIFICATION_DATABASE_DIRECTORY,
  applyMigrations,
  inspectDatabase,
  openDatabase,
  resolveRuntimeDatabasePath,
} from "../db/sqlite.mjs";

const execFileAsync = promisify(execFile);

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-schedule-db-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function copyMigrationsThrough(directory, lastMigrationName) {
  const migrationsPath = resolve(directory, "migrations");
  await mkdir(migrationsPath);
  const migrationNames = (await readdir(resolve(PROJECT_ROOT, "drizzle")))
    .filter((name) => name.endsWith(".sql") && name.localeCompare(lastMigrationName) <= 0)
    .sort((a, b) => a.localeCompare(b));
  for (const name of migrationNames) {
    await cp(resolve(PROJECT_ROOT, "drizzle", name), resolve(migrationsPath, name));
  }
  return migrationsPath;
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
      assert.deepEqual(
        database.prepare("SELECT name FROM children ORDER BY id").all().map(({ name }) => name),
        ["ベビーローズA", "ベビーローズB"],
      );
      assert.deepEqual(
        database.prepare("SELECT target_month, status, is_parent_target FROM submission_periods ORDER BY target_month").all()
          .map(({ target_month, status, is_parent_target }) => ({ target_month, status, is_parent_target })),
        [
          { target_month: "2026-05", status: "closed", is_parent_target: 0 },
          { target_month: "2026-06", status: "closed", is_parent_target: 0 },
          { target_month: "2099-04", status: "open", is_parent_target: 1 },
        ],
      );
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

test("validates and backs up a complete database through migration 0007", async () => {
  await withTemporaryDirectory(async (directory) => {
    const migrationsPath = await copyMigrationsThrough(directory, "0007_reflective_zombie.sql");
    const databasePath = resolve(directory, "through-0007.sqlite");
    const database = openDatabase(databasePath);
    try {
      await applyMigrations(database, migrationsPath);
      const report = inspectDatabase(database);
      assert.equal(report.migrationsOk, true);
      assert.deepEqual(report.missingTables, []);
      assert.equal(report.requiredTables.includes("staff_schedule_months"), false);
    } finally {
      database.close();
    }

    const backupPath = await backupDatabase({
      databasePath,
      backupDirectory: resolve(directory, "backups"),
      now: new Date(2099, 1, 3, 4, 5, 6, 7),
    });
    await access(backupPath);
  });
});

test("requires the 0008 schedule tables when migration 0008 is recorded", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = resolve(directory, "through-0008.sqlite");
    const database = openDatabase(databasePath);
    try {
      await applyMigrations(database);
      assert.equal(inspectDatabase(database).migrationsOk, true);
      assert.deepEqual(inspectDatabase(database).missingTables, []);

      database.exec("DROP TABLE staff_schedule_segments");
      const damaged = inspectDatabase(database);
      assert.equal(damaged.migrationsOk, true);
      assert.deepEqual(damaged.missingTables, ["staff_schedule_segments"]);
    } finally {
      database.close();
    }
    await assert.rejects(
      backupDatabase({ databasePath, backupDirectory: resolve(directory, "backups") }),
      /staff_schedule_segments/,
    );
  });
});

test("rejects a missing pre-0008 table and a changed migration hash", async () => {
  await withTemporaryDirectory(async (directory) => {
    const migrationsPath = await copyMigrationsThrough(directory, "0007_reflective_zombie.sql");
    const missingTablePath = resolve(directory, "missing-table.sqlite");
    let database = openDatabase(missingTablePath);
    await applyMigrations(database, migrationsPath);
    database.exec("DROP TABLE staff_roles");
    assert.deepEqual(inspectDatabase(database).missingTables, ["staff_roles"]);
    database.close();
    await assert.rejects(
      backupDatabase({ databasePath: missingTablePath, backupDirectory: resolve(directory, "backups-a") }),
      /staff_roles/,
    );

    const changedHashPath = resolve(directory, "changed-hash.sqlite");
    database = openDatabase(changedHashPath);
    await applyMigrations(database, migrationsPath);
    database.prepare("UPDATE _schema_migrations SET checksum = ? WHERE name = ?")
      .run("invalid-checksum", "0007_reflective_zombie.sql");
    const changedHash = inspectDatabase(database);
    assert.equal(changedHash.migrationsOk, false);
    assert.match(changedHash.migrationErrors.join(" "), /hash/);
    database.close();
    await assert.rejects(
      backupDatabase({ databasePath: changedHashPath, backupDirectory: resolve(directory, "backups-b") }),
      /hash/,
    );
  });
});

test("rejects restore when the source file is not explicitly provided", async () => {
  await assert.rejects(
    restoreDatabase({ databasePath: resolve(tmpdir(), "not-created.sqlite") }),
    /--file/,
  );
});

test("requires an explicit database inside .verification when verification mode is enabled", () => {
  const verificationDatabase = resolve(VERIFICATION_DATABASE_DIRECTORY, "safe-test.sqlite");
  assert.equal(
    resolveRuntimeDatabasePath(verificationDatabase, { verificationMode: true, environmentDatabasePath: undefined }),
    verificationDatabase,
  );
  assert.throws(
    () => resolveRuntimeDatabasePath(undefined, { verificationMode: true, environmentDatabasePath: undefined }),
    /NURSERY_DB_PATH/,
  );
  assert.throws(
    () => resolveRuntimeDatabasePath(resolve(PROJECT_ROOT, "local-data", "must-not-open.sqlite"), { verificationMode: true }),
    /.verification配下/,
  );
});

test("prints CLI help and rejects invalid auth commands before opening a database", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = resolve(directory, "must-not-be-created.sqlite");
    const environment = {
      ...process.env,
      NURSERY_DB_PATH: databasePath,
      NURSERY_VERIFICATION_MODE: "false",
    };
    const authCli = resolve(PROJECT_ROOT, "db", "auth-cli.mjs");
    const databaseCli = resolve(PROJECT_ROOT, "db", "cli.mjs");

    const authHelp = await execFileAsync(process.execPath, [authCli, "--help"], { env: environment });
    assert.match(authHelp.stdout, /create\|reset/);
    await assert.rejects(access(databasePath));

    await assert.rejects(
      execFileAsync(process.execPath, [authCli, "unsupported"], { env: environment }),
      (error) => error.code === 1 && /create または reset/.test(error.stderr),
    );
    await assert.rejects(access(databasePath));

    const databaseHelp = await execFileAsync(process.execPath, [databaseCli, "--help"], { env: environment });
    assert.match(databaseHelp.stdout, /migrate\|seed\|status\|backup\|restore/);
    await assert.rejects(access(databasePath));
  });
});
