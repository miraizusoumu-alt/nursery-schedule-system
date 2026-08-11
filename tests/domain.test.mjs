import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

let vite;
let placement;
let prototype;
let schedule;
let shift;
let storage;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    logLevel: "silent",
  });
  [placement, prototype, schedule, shift, storage] = await Promise.all([
    vite.ssrLoadModule("/lib/domain/placement.ts"),
    vite.ssrLoadModule("/lib/domain/prototype.ts"),
    vite.ssrLoadModule("/lib/domain/schedule.ts"),
    vite.ssrLoadModule("/lib/domain/shift.ts"),
    vite.ssrLoadModule("/lib/storage/local-storage.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

const fixedNow = new Date(2026, 7, 9, 12, 0, 0);

test("loads legacy version data without changing the storage key or losing monthly schedules", () => {
  const initial = prototype.createInitialStore(fixedNow);
  const child = initial.children[0];
  const month = initial.admin.selectedMonth;
  const key = schedule.scheduleKey(child.id, month);
  const legacy = {
    version: 2,
    children: [child],
    schedules: { [key]: initial.schedules[key] },
    admin: {
      selectedMonth: month,
      selectedChildId: child.id,
      closedDatesByMonth: initial.admin.closedDatesByMonth,
    },
  };

  const normalized = storage.normalizeStore(legacy, fixedNow);
  assert.equal(storage.STORAGE_KEY, "nursery-schedule-prototype-v2");
  assert.equal(normalized.version, 3);
  assert.equal(normalized.children[0].id, child.id);
  assert.equal(normalized.schedules[key].id, initial.schedules[key].id);
  assert.equal(normalized.admin.selectedMonth, month);
});

test("round-trips all major store collections through local storage", () => {
  const memory = new MemoryStorage();
  const original = prototype.createInitialStore(fixedNow);
  original.histories.push({
    id: "history-test",
    changedAt: fixedNow.toISOString(),
    actorId: "admin",
    actorType: "admin",
    target: "test",
    before: { value: 1 },
    after: { value: 2 },
    reason: "test",
    targetMonth: original.admin.selectedMonth,
  });

  storage.savePrototypeStore(memory, original);
  const loaded = storage.loadPrototypeStore(memory, fixedNow);

  assert.equal(loaded.recovered, false);
  assert.equal(loaded.store.version, 3);
  assert.deepEqual(Object.keys(loaded.store.schedules), Object.keys(original.schedules));
  assert.deepEqual(Object.keys(loaded.store.leaveRequests), Object.keys(original.leaveRequests));
  assert.deepEqual(Object.keys(loaded.store.shifts), Object.keys(original.shifts));
  assert.equal(loaded.store.children.length, original.children.length);
  assert.equal(loaded.store.staff.length, original.staff.length);
  assert.equal(loaded.store.placementRules.length, original.placementRules.length);
  assert.equal(loaded.store.histories.at(-1)?.id, "history-test");
  assert.equal(loaded.store.admin.selectedMonth, original.admin.selectedMonth);
});

test("keeps five-minute schedule input when aggregating child usage", () => {
  const month = "2026-08";
  const child = {
    id: "child-five-minute",
    name: "試作 園児",
    kana: "しさく えんじ",
    className: "試作組",
    ageGroup: "0歳児",
    basePattern: {
      mon: { enabled: true, start: "08:05", end: "08:20" },
      tue: { enabled: false, start: "08:05", end: "08:20" },
      wed: { enabled: false, start: "08:05", end: "08:20" },
      thu: { enabled: false, start: "08:05", end: "08:20" },
      fri: { enabled: false, start: "08:05", end: "08:20" },
      sat: { enabled: false, start: "08:05", end: "08:20" },
    },
  };
  const record = schedule.createScheduleRecord(child, month, [], "draft", undefined, fixedNow);
  const slots = placement.aggregateChildUsage(month, { [record.id]: record }, [child], 15);
  const monday = slots.filter((slot) => slot.date === "2026-08-03");

  assert.equal(record.days["2026-08-03"].start, "08:05");
  assert.equal(record.days["2026-08-03"].end, "08:20");
  assert.deepEqual(
    monday.map((slot) => [slot.start, slot.end, slot.totalChildren]),
    [
      ["08:00", "08:15", 1],
      ["08:15", "08:30", 1],
    ],
  );
});

test("calculates required staff by age group", () => {
  const slot = {
    date: "2026-09-07",
    start: "09:00",
    end: "09:15",
    countsByAgeGroup: { "0歳児": 4, "1-2歳児": 7, "3歳以上児": 21 },
    totalChildren: 32,
    children: [],
  };
  const rules = [
    { id: "r0", ageGroup: "0歳児", childrenPerStaff: 3, minStaff: 1, requiredQualified: 1, openingStaff: 1, closingStaff: 1, extraStaff: 0, ruleType: "law" },
    { id: "r1", ageGroup: "1-2歳児", childrenPerStaff: 6, minStaff: 1, requiredQualified: 1, openingStaff: 1, closingStaff: 1, extraStaff: 0, ruleType: "law" },
    { id: "r3", ageGroup: "3歳以上児", childrenPerStaff: 20, minStaff: 1, requiredQualified: 1, openingStaff: 1, closingStaff: 1, extraStaff: 0, ruleType: "law" },
  ];

  const required = placement.calculateRequiredStaff(slot, rules);
  assert.equal(required.requiredStaff, 6);
  assert.equal(required.requiredQualified, 1);
});

test("respects staff availability and leave requests during generation", () => {
  const store = prototype.createInitialStore(fixedNow);
  const month = store.admin.selectedMonth;
  const date = `${month}-07`;
  const staff = store.staff.find((item) => item.id === prototype.CURRENT_STAFF_ID);
  assert.ok(staff);
  assert.ok(shift.staffAvailableForDate(staff, date));
  assert.equal(shift.staffAvailableForDate({ ...staff, fixedDaysOff: ["mon"] }, date), null);

  const leaveId = schedule.leaveKey(staff.id, month, date);
  store.leaveRequests[leaveId] = {
    id: leaveId,
    staffId: staff.id,
    targetMonth: month,
    date,
    submittedAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  };
  assert.equal(shift.staffHasLeave(staff.id, month, date, store.leaveRequests), true);

  const generated = shift.generateShiftForMonth(store, month, date, fixedNow);
  assert.equal(generated.assignments.some((assignment) => assignment.date === date && assignment.staffId === staff.id), false);
  generated.assignments
    .filter((assignment) => assignment.date === date)
    .forEach((assignment) => {
      const assignedStaff = store.staff.find((item) => item.id === assignment.staffId);
      const available = shift.staffAvailableForDate(assignedStaff, date);
      assert.ok(available);
      assert.ok(schedule.timeToMinutes(assignment.start) >= schedule.timeToMinutes(available.start));
      assert.ok(schedule.timeToMinutes(assignment.end) <= schedule.timeToMinutes(available.end));
    });
});

test("preserves fixed assignments when regenerating a day", () => {
  const store = prototype.createInitialStore(fixedNow);
  const month = store.admin.selectedMonth;
  const date = `${month}-07`;
  const key = schedule.shiftKey(month);
  const fixed = {
    id: "fixed-test-assignment",
    staffId: prototype.CURRENT_STAFF_ID,
    date,
    start: "08:30",
    end: "17:30",
    breakMinutes: 60,
    role: "early",
    fixed: true,
    source: "manual",
    note: "test",
  };
  store.shifts[key] = { ...store.shifts[key], assignments: [fixed] };

  const generated = shift.generateShiftForMonth(store, month, date, fixedNow);
  assert.deepEqual(generated.assignments.find((assignment) => assignment.id === fixed.id), fixed);
});

test("recovers safely from missing fields and malformed JSON without overwriting storage", () => {
  const normalized = storage.normalizeStore(
    { version: 3, children: null, staff: "invalid", schedules: null, admin: null },
    fixedNow,
  );
  assert.equal(normalized.version, 3);
  assert.ok(normalized.children.length > 0);
  assert.ok(normalized.staff.length > 0);
  assert.ok(Object.keys(normalized.schedules).length > 0);

  const memory = new MemoryStorage();
  memory.setItem(storage.STORAGE_KEY, "{not-json");
  const malformedBefore = memory.getItem(storage.STORAGE_KEY);
  const loaded = storage.loadPrototypeStore(memory, fixedNow);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.store.version, 3);
  assert.equal(memory.getItem(storage.STORAGE_KEY), malformedBefore);
});

test("backs up the original local storage JSON exactly once without changing the source", () => {
  const memory = new MemoryStorage();
  const originalJson = '{"version":3,"marker":"original"}';
  memory.setItem(storage.STORAGE_KEY, originalJson);

  const first = storage.backupPrototypeStoreOnce(memory, fixedNow);
  assert.equal(first.status, "created");
  assert.equal(first.verified, true);
  assert.equal(memory.getItem(storage.STORAGE_KEY), originalJson);
  assert.equal(memory.getItem(storage.STORAGE_BACKUP_KEY), originalJson);

  memory.setItem(storage.STORAGE_KEY, '{"version":3,"marker":"newer"}');
  const second = storage.backupPrototypeStoreOnce(memory, new Date(fixedNow.getTime() + 1000));
  assert.equal(second.status, "already-backed-up");
  assert.equal(second.verified, true);
  assert.equal(memory.getItem(storage.STORAGE_BACKUP_KEY), originalJson);
});

test("reports safely when no local storage source exists", () => {
  const memory = new MemoryStorage();
  const result = storage.backupPrototypeStoreOnce(memory, fixedNow);
  assert.equal(result.status, "no-source");
  assert.equal(result.verified, false);
  assert.equal(memory.getItem(storage.STORAGE_KEY), null);
  assert.equal(memory.getItem(storage.STORAGE_BACKUP_KEY), null);
});
