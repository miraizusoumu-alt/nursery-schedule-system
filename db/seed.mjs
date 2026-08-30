const DEMO_MONTH = "2099-04";
const DEMO_PERIOD_ID = "demo-period-2099-04";
const DEMO_FAMILY_ID = "demo-family-001";
const DEMO_SUBMISSION_ID = "demo-submission-001-2099-04";

function upsert(database, sqlText, values) {
  database.prepare(sqlText).run(...values);
}

export function seedDevelopmentData(database, now = new Date()) {
  const timestamp = now.toISOString();
  const children = [
    ["demo-child-001", "DEMO-CHILD-001", "ベビーローズA", "べびーろーずえー", "0歳児", "2025-06-15"],
    ["demo-child-002", "DEMO-CHILD-002", "ベビーローズB", "べびーろーずびー", "1歳児", "2024-09-01"],
  ];
  database.exec("BEGIN IMMEDIATE");
  try {
    upsert(
      database,
      `INSERT INTO families (id, family_code, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET family_code = excluded.family_code, display_name = excluded.display_name, updated_at = excluded.updated_at`,
      [DEMO_FAMILY_ID, "DEMO-FAMILY-001", "架空テスト家庭A", timestamp, timestamp],
    );
    upsert(
      database,
      `INSERT INTO family_accounts (id, family_id, login_id, password_hash, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET login_id = excluded.login_id, password_hash = NULL, must_change_password = 0, updated_at = excluded.updated_at`,
      ["demo-family-account-001", DEMO_FAMILY_ID, "demo-family-001", timestamp, timestamp],
    );

    for (const child of children) {
      upsert(
        database,
        `INSERT INTO children (id, child_code, name, kana, class_name, birth_date, enrollment_date, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '2026-04-01', 'enrolled', ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kana = excluded.kana, class_name = excluded.class_name,
           birth_date = excluded.birth_date, enrollment_date = excluded.enrollment_date, updated_at = excluded.updated_at`,
        [...child, timestamp, timestamp],
      );
      upsert(
        database,
        `INSERT INTO family_children (family_id, child_id, relationship_label, is_primary, sort_order, active_from, active_to, created_at)
         VALUES (?, ?, '保護者（架空）', 1, ?, '2026-04-01', NULL, ?)
         ON CONFLICT(family_id, child_id) DO UPDATE SET sort_order = excluded.sort_order, active_from = excluded.active_from, active_to = NULL`,
        [DEMO_FAMILY_ID, child[0], children.indexOf(child), timestamp],
      );
    }

    upsert(
      database,
      `INSERT INTO administrators (id, login_id, display_name, role, password_hash, must_change_password, status, created_at, updated_at)
       VALUES ('demo-admin-001', 'demo-admin-001', '架空 管理者', 'master', NULL, 0, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, password_hash = NULL, must_change_password = 0, updated_at = excluded.updated_at`,
      [timestamp, timestamp],
    );

    for (const childId of children.map((child) => child[0])) {
      for (let weekday = 1; weekday <= 6; weekday += 1) {
        const enabled = weekday <= 5 ? 1 : 0;
        upsert(
          database,
          `INSERT INTO basic_usage_patterns (id, child_id, weekday, enabled, arrival_time, departure_time, valid_from, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '2026-04-01', ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, arrival_time = excluded.arrival_time, departure_time = excluded.departure_time, updated_at = excluded.updated_at`,
          [`demo-pattern-${childId}-${weekday}`, childId, weekday, enabled, "08:30", "17:30", timestamp, timestamp],
        );
      }
    }

    upsert(
      database,
      `INSERT INTO submission_periods (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES (?, ?, '2099-03-25T14:59:59.000Z', 'open', 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET deadline_at = excluded.deadline_at, status = excluded.status,
         is_parent_target = excluded.is_parent_target, updated_at = excluded.updated_at`,
      [DEMO_PERIOD_ID, DEMO_MONTH, timestamp, timestamp],
    );
    for (const [id, targetMonth, deadlineAt] of [
      ["demo-period-2026-05", "2026-05", "2026-04-25T14:59:59.000Z"],
      ["demo-period-2026-06", "2026-06", "2026-05-25T14:59:59.000Z"],
    ]) {
      upsert(
        database,
        `INSERT INTO submission_periods (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
         VALUES (?, ?, ?, 'closed', 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET deadline_at = excluded.deadline_at, status = 'closed',
           is_parent_target = 0, updated_at = excluded.updated_at`,
        [id, targetMonth, deadlineAt, timestamp, timestamp],
      );
    }
    upsert(
      database,
      `INSERT INTO closure_days (id, date, name, type, parent_input_allowed, note, created_at, updated_at)
       VALUES ('demo-closure-2099-04-29', '2099-04-29', '架空休園日', 'closed', 0, '開発確認用の架空データ', ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, note = excluded.note, updated_at = excluded.updated_at`,
      [timestamp, timestamp],
    );
    upsert(
      database,
      `INSERT INTO family_submissions (id, family_id, submission_period_id, status, submitted_at, last_updated_at, created_at)
       VALUES (?, ?, ?, 'draft', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_updated_at = excluded.last_updated_at`,
      [DEMO_SUBMISSION_ID, DEMO_FAMILY_ID, DEMO_PERIOD_ID, timestamp, timestamp],
    );

    const basePatternSnapshot = JSON.stringify({ weekdays: "開発用架空パターン", start: "08:30", end: "17:30" });
    for (const child of children) {
      const monthlyId = `demo-monthly-${child[0]}-${DEMO_MONTH}`;
      upsert(
        database,
        `INSERT INTO monthly_schedules (id, child_id, submission_period_id, family_submission_id, status, base_pattern_snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET base_pattern_snapshot_json = excluded.base_pattern_snapshot_json, updated_at = excluded.updated_at`,
        [monthlyId, child[0], DEMO_PERIOD_ID, DEMO_SUBMISSION_ID, basePatternSnapshot, timestamp, timestamp],
      );
      for (const [date, status] of [["2099-04-01", "using"], ["2099-04-02", "using"], ["2099-04-03", "off"]]) {
        upsert(
          database,
          `INSERT INTO daily_schedules (id, monthly_schedule_id, date, usage_status, arrival_time, departure_time, source, changed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'base', 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET usage_status = excluded.usage_status, arrival_time = excluded.arrival_time, departure_time = excluded.departure_time, updated_at = excluded.updated_at`,
          [`demo-day-${child[0]}-${date}`, monthlyId, date, status, status === "using" ? "08:30" : null, status === "using" ? "17:30" : null, timestamp, timestamp],
        );
      }
    }

    [
      ["demo-reason-001", "保護者からの連絡", 1],
      ["demo-reason-002", "園の都合による変更", 2],
      ["demo-reason-003", "入力誤りの訂正", 3],
      ["demo-reason-004", "基本利用時間の見直し", 4],
    ].forEach(([id, name, sortOrder]) => {
      upsert(
        database,
        `INSERT INTO standard_reasons (id, name, active, sort_order, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        [id, name, sortOrder, timestamp, timestamp],
      );
    });

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    familyId: DEMO_FAMILY_ID,
    childIds: children.map((child) => child[0]),
    targetMonth: DEMO_MONTH,
  };
}
