import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateAutomaticChildcareShift,
  mergeChildcareAssignmentsIntoSegments,
} from "../lib/server/staffing/automatic-shift-generator.mjs";
import { staffDateWorkKey } from "../lib/server/staffing/automatic-work-limits.mjs";

function addMinutes(time, amount) {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + amount;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function requirement(startTime, requiredChildcareWorkers, requiredLicensedNurseryTeachers = 0, date = "2026-09-07") {
  return {
    date,
    startTime,
    endTime: addMinutes(startTime, 15),
    requiredChildcareWorkers,
    requiredLicensedNurseryTeachers,
  };
}

function staff(id, options = {}) {
  const qualification = Object.hasOwn(options, "qualification")
    ? options.qualification
    : "licensed_nursery_teacher";
  return {
    id,
    staffCode: options.staffCode ?? `ST${id}`,
    name: `架空 職員${id}`,
    employmentStartDate: "2026-01-01",
    employmentEndDate: null,
    status: "active",
    assignedRoles: [{ type: "nursery_teacher_role", validFrom: "2026-01-01", validTo: null }],
    validQualifications: qualification ? [{ type: qualification, validFrom: "2026-01-01", validTo: null }] : [],
    workConditions: [{
      validFrom: "2026-01-01",
      validTo: null,
      employmentType: "常勤",
      availability: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        available: true,
        startTime: options.availableStartTime ?? "09:00",
        endTime: options.availableEndTime ?? "18:00",
      })),
    }],
    schedulePreferences: options.schedulePreferences ?? [],
    scheduledDays: options.scheduledDays ?? [],
  };
}

function partTimeStaff(id, minimumMinutes, options = {}) {
  const profile = staff(id, options);
  profile.workConditions[0] = {
    ...profile.workConditions[0],
    employmentType: "非常勤",
    weeklyMinutesLimit: options.weeklyMinutesLimit ?? 40 * 60,
    weeklyMinutesLimitType: "inclusive",
    preferredWeeklyWorkDaysMin: 1,
    weeklyWorkDaysMax: options.weeklyWorkDaysMax ?? 6,
    dailyWorkMinutesMin: minimumMinutes,
    dailyWorkMinutesMax: options.dailyWorkMinutesMax ?? 480,
  };
  return profile;
}

function workLimitOptions(profiles, targetMonth = "2026-09") {
  return {
    workLimitProfiles: profiles.map((profile) => ({
      staffId: profile.id,
      targetMonth,
      dailyLimitMinutes: 480,
      monthlyLimitMinutes: profile.workConditions[0].employmentType === "常勤" ? 176 * 60 : null,
      workConditions: profile.workConditions,
      schedulePreferences: profile.schedulePreferences,
      existingDays: [],
    })),
  };
}

function workDays(dates, staffId = "A") {
  return dates.map((date) => ({ staffId, date, dayType: "work", segments: [] }));
}

function quarterHourRequirements(date, startTime, count) {
  return Array.from({ length: count }, (_, index) => {
    return requirement(addMinutes(startTime, index * 15), 1, 0, date);
  });
}

function withFridayAvailabilityCandidates(profile) {
  return {
    ...profile,
    workConditions: profile.workConditions.map((condition) => ({
      ...condition,
      availability: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        available: weekday === 5,
        startTime: weekday === 5 ? "10:00" : null,
        endTime: weekday === 5 ? "14:30" : null,
        candidates: weekday === 5 ? [
          {
            candidateId: "friday-morning",
            candidateOrder: 0,
            startTime: "10:00",
            endTime: "14:30",
            weekOrdinals: null,
          },
          {
            candidateId: "friday-afternoon",
            candidateOrder: 1,
            startTime: "15:00",
            endTime: "18:30",
            weekOrdinals: null,
          },
        ] : [],
      })),
    })),
  };
}

test("assigns nobody when a quarter-hour slot requires no staff", () => {
  const result = calculateAutomaticChildcareShift([requirement("09:00", 0)], [staff("A")]);
  assert.equal(result.slots[0].assignedChildcareWorkerCount, 0);
  assert.equal(result.slots[0].assignedLicensedNurseryTeacherCount, 0);
  assert.deepEqual(result.slots[0].assignedStaff, []);
  assert.equal(result.slots[0].childcareWorkerShortage, 0);
});

test("promotes a zero-minute part-time day into a shortage-rooted three-hour block", () => {
  const fullTime = staff("A", { staffCode: "ST0001" });
  const partTime = partTimeStaff("H", 180, { staffCode: "ST0002" });
  const requirements = quarterHourRequirements("2026-09-07", "09:00", 12);
  requirements.at(-1).requiredChildcareWorkers = 2;

  const result = calculateAutomaticChildcareShift(
    requirements,
    [fullTime, partTime],
    workLimitOptions([fullTime, partTime]),
  );
  const promotion = result.minimumWorkBlockPromotions.find((entry) => entry.staffId === "H");

  assert.equal(promotion.initialMinutes, 0);
  assert.equal(promotion.minimumMinutes, 180);
  assert.equal(result.slots.filter((slot) => slot.assignedStaff.some((entry) => entry.staffId === "H")).length, 12);
  assert.equal(result.slots.every((slot) => slot.assignedChildcareWorkerCount === slot.requiredChildcareWorkers), true);
});

test("promotes a zero-minute part-time day into a six-hour block", () => {
  const fullTime = staff("A", { staffCode: "ST0001" });
  const partTime = partTimeStaff("J", 360, { staffCode: "ST0002" });
  const requirements = quarterHourRequirements("2026-09-07", "09:00", 24);
  requirements.at(-1).requiredChildcareWorkers = 2;

  const result = calculateAutomaticChildcareShift(
    requirements,
    [fullTime, partTime],
    workLimitOptions([fullTime, partTime]),
  );
  const promotion = result.minimumWorkBlockPromotions.find((entry) => entry.staffId === "J");

  assert.equal(promotion.initialMinutes, 0);
  assert.equal(promotion.minimumMinutes, 360);
  assert.equal(result.slots.filter((slot) => slot.assignedStaff.some((entry) => entry.staffId === "J")).length, 24);
});

test("does not create a part-time minimum block without a shortage anchor", () => {
  const fullTime = staff("A", { staffCode: "ST0001" });
  const partTime = partTimeStaff("H", 180, { staffCode: "ST0002" });
  const requirements = quarterHourRequirements("2026-09-07", "09:00", 12);

  const result = calculateAutomaticChildcareShift(
    requirements,
    [fullTime, partTime],
    workLimitOptions([fullTime, partTime]),
  );

  assert.equal(result.minimumWorkBlockPromotions.length, 0);
  assert.equal(result.slots.some((slot) => slot.assignedStaff.some((entry) => entry.staffId === "H")), false);
});

test("does not pad a part-time minimum block with zero-demand slots", () => {
  const partTime = partTimeStaff("E", 180, { staffCode: "ST0001" });
  const requirements = [
    ...quarterHourRequirements("2026-09-07", "09:00", 8),
    ...Array.from({ length: 4 }, (_, index) => requirement(
      addMinutes("11:00", index * 15),
      0,
      0,
      "2026-09-07",
    )),
  ];

  const result = calculateAutomaticChildcareShift(
    requirements,
    [partTime],
    workLimitOptions([partTime]),
  );

  assert.equal(result.minimumWorkBlockPromotions.length, 0);
  assert.equal(result.slots.every((slot) => slot.assignedChildcareWorkerCount === 0), true);
  assert.equal(result.slots.slice(8).every((slot) => slot.requiredChildcareWorkers === 0), true);
});

test("does not break another part-time employee's daily minimum to form a block", () => {
  const established = partTimeStaff("Q", 180, { staffCode: "ST0001" });
  const candidate = partTimeStaff("H", 180, { staffCode: "ST0002" });
  const requirements = quarterHourRequirements("2026-09-07", "09:00", 12);
  requirements.at(-1).requiredChildcareWorkers = 2;

  const result = calculateAutomaticChildcareShift(
    requirements,
    [established, candidate],
    workLimitOptions([established, candidate]),
  );

  assert.equal(result.slots.filter((slot) => slot.assignedStaff.some((entry) => entry.staffId === "Q")).length, 12);
  assert.equal(result.slots.some((slot) => slot.assignedStaff.some((entry) => entry.staffId === "H")), false);
  assert.equal(result.slots.at(-1).childcareWorkerShortage, 1);
});

test("keeps minimum-block promotion deterministic across input order", () => {
  const fullTime = staff("A", { staffCode: "ST0001" });
  const h = partTimeStaff("H", 180, { staffCode: "ST0002" });
  const j = partTimeStaff("J", 180, { staffCode: "ST0003" });
  const requirements = quarterHourRequirements("2026-09-07", "09:00", 12);
  requirements.at(-1).requiredChildcareWorkers = 2;
  const profiles = [fullTime, h, j];

  const first = calculateAutomaticChildcareShift(requirements, profiles, workLimitOptions(profiles));
  const reversedProfiles = [...profiles].reverse();
  const second = calculateAutomaticChildcareShift(
    [...requirements].reverse(),
    reversedProfiles,
    workLimitOptions(reversedProfiles),
  );

  assert.deepEqual(first, second);
});

test("refills a shortage with a full-time candidate after removing an unresolved short shift", () => {
  const shortPartTime = partTimeStaff("E", 60, { staffCode: "ST0001" });
  const fullTime = staff("D", { staffCode: "ST0002" });
  const profiles = [shortPartTime, fullTime];

  const result = calculateAutomaticChildcareShift(
    [requirement("09:00", 1)],
    profiles,
    workLimitOptions(profiles),
  );

  assert.deepEqual(result.slots[0].assignedStaff.map((entry) => entry.staffId), ["D"]);
  assert.equal(result.minimumWorkShortageRefills.length, 1);
  assert.equal(result.slots[0].childcareWorkerShortage, 0);
});

test("keeps preference, holiday, availability, public-day-off, and consecutive gates during block planning", () => {
  const date = "2026-09-07";
  const cases = [
    {
      label: "day-off preference",
      configure(profile) {
        profile.schedulePreferences = [{ date, preferenceType: "day_off", startTime: null, endTime: null }];
      },
    },
    {
      label: "holiday unavailable",
      configure(profile) {
        profile.workConditions[0].holidayWorkAllowed = false;
        profile.nationalHolidays = [{ holidayDate: date, name: "架空祝日", source: "test" }];
      },
    },
    {
      label: "insufficient availability",
      configure(profile) {
        profile.workConditions[0].availability = profile.workConditions[0].availability.map((entry) => ({
          ...entry,
          startTime: "09:00",
          endTime: "11:00",
        }));
      },
    },
    {
      label: "public day off",
      configure(profile) {
        profile.scheduledDays = [{ staffId: profile.id, date, dayType: "day_off", segments: [] }];
      },
    },
    {
      label: "seventh consecutive day",
      configure(profile) {
        profile.scheduledDays = workDays([
          "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
        ], profile.id);
      },
    },
  ];

  for (const scenario of cases) {
    const unresolved = partTimeStaff(`X-${scenario.label}`, 240, { staffCode: "ST0001" });
    const candidate = partTimeStaff(`H-${scenario.label}`, 180, { staffCode: "ST0002" });
    scenario.configure(candidate);
    const profiles = [unresolved, candidate];
    const result = calculateAutomaticChildcareShift(
      quarterHourRequirements(date, "09:00", 12),
      profiles,
      workLimitOptions(profiles),
    );
    assert.equal(
      result.slots.some((slot) => slot.assignedStaff.some((entry) => entry.staffId === candidate.id)),
      false,
      scenario.label,
    );
  }
});

test("keeps part-time daily and weekly upper limits during block planning", () => {
  const date = "2026-09-10";
  const cases = [
    {
      label: "daily",
      configure(profile, limitProfile) {
        profile.workConditions[0].dailyWorkMinutesMax = 240;
        limitProfile.workConditions = profile.workConditions;
        limitProfile.existingDays = [{ date, scheduledWorkMinutes: 75, breakMinutes: 0 }];
      },
    },
    {
      label: "weekly minutes",
      configure(profile, limitProfile) {
        profile.workConditions[0].weeklyMinutesLimit = 1200;
        limitProfile.workConditions = profile.workConditions;
        limitProfile.existingDays = [
          { date: "2026-09-07", scheduledWorkMinutes: 350, breakMinutes: 0 },
          { date: "2026-09-08", scheduledWorkMinutes: 350, breakMinutes: 0 },
          { date: "2026-09-09", scheduledWorkMinutes: 350, breakMinutes: 0 },
        ];
      },
    },
    {
      label: "weekly days",
      configure(profile, limitProfile) {
        profile.workConditions[0].weeklyWorkDaysMax = 3;
        limitProfile.workConditions = profile.workConditions;
        limitProfile.existingDays = [
          { date: "2026-09-07", scheduledWorkMinutes: 180, breakMinutes: 0 },
          { date: "2026-09-08", scheduledWorkMinutes: 180, breakMinutes: 0 },
          { date: "2026-09-09", scheduledWorkMinutes: 180, breakMinutes: 0 },
        ];
      },
    },
  ];

  for (const scenario of cases) {
    const unresolved = partTimeStaff(`X-${scenario.label}`, 240, { staffCode: "ST0001" });
    const candidate = partTimeStaff(`H-${scenario.label}`, 180, { staffCode: "ST0002" });
    const profiles = [unresolved, candidate];
    const options = workLimitOptions(profiles);
    scenario.configure(candidate, options.workLimitProfiles.find((entry) => entry.staffId === candidate.id));
    const result = calculateAutomaticChildcareShift(
      quarterHourRequirements(date, "09:00", 12),
      profiles,
      options,
    );
    assert.equal(
      result.slots.some((slot) => slot.assignedStaff.some((entry) => entry.staffId === candidate.id)),
      false,
      scenario.label,
    );
  }
});

test("does not replace the only licensed assignment with an unlicensed minimum block", () => {
  const fullTime = staff("A", { staffCode: "ST0001" });
  const support = partTimeStaff("H", 180, {
    staffCode: "ST0002",
    qualification: "childcare_support_worker_local_childcare",
  });
  const requirements = quarterHourRequirements("2026-09-07", "09:00", 12);
  for (const slot of requirements) slot.requiredLicensedNurseryTeachers = 1;
  requirements.at(-1).requiredChildcareWorkers = 2;

  const result = calculateAutomaticChildcareShift(
    requirements,
    [fullTime, support],
    workLimitOptions([fullTime, support]),
  );

  assert.equal(result.slots.every((slot) => slot.assignedLicensedNurseryTeacherCount === 1), true);
  assert.equal(result.slots.some((slot) => slot.assignedStaff.some((entry) => entry.staffId === "H")), false);
  assert.equal(result.slots.at(-1).childcareWorkerShortage, 1);
  assert.equal(result.slots.at(-1).licensedNurseryTeacherShortage, 0);
});

test("secures licensed staff first and then fills the remaining childcare requirement", () => {
  const licensed = staff("A", { staffCode: "ST0099" });
  const support = staff("B", {
    staffCode: "ST0001",
    qualification: "childcare_support_worker_local_childcare",
  });
  const unqualified = staff("C", { staffCode: "ST0000", qualification: null });
  const result = calculateAutomaticChildcareShift(
    [requirement("09:00", 2, 1)],
    [unqualified, support, licensed],
  ).slots[0];
  assert.deepEqual(result.assignedStaff.map((entry) => entry.staffId), ["A", "B"]);
  assert.equal(result.assignedChildcareWorkerCount, 2);
  assert.equal(result.assignedLicensedNurseryTeacherCount, 1);
  assert.equal(result.childcareWorkerShortage, 0);
  assert.equal(result.licensedNurseryTeacherShortage, 0);
});

test("reports licensed and total shortages without promoting support workers", () => {
  const licensed = staff("A");
  const support = staff("B", { qualification: "childcare_support_worker_local_childcare" });
  const result = calculateAutomaticChildcareShift(
    [requirement("09:00", 3, 2)],
    [support, licensed],
  ).slots[0];
  assert.equal(result.assignedChildcareWorkerCount, 2);
  assert.equal(result.assignedLicensedNurseryTeacherCount, 1);
  assert.equal(result.childcareWorkerShortage, 1);
  assert.equal(result.licensedNurseryTeacherShortage, 1);

  const supportOnly = calculateAutomaticChildcareShift(
    [requirement("09:00", 1, 1)],
    [support],
  ).slots[0];
  assert.equal(supportOnly.assignedChildcareWorkerCount, 1);
  assert.equal(supportOnly.assignedLicensedNurseryTeacherCount, 0);
  assert.equal(supportOnly.licensedNurseryTeacherShortage, 1);
});

test("honors day-off and work-time preferences without extending outside them", () => {
  const dayOff = staff("A", {
    schedulePreferences: [{ date: "2026-09-07", preferenceType: "day_off", startTime: null, endTime: null }],
  });
  const dayOffResult = calculateAutomaticChildcareShift([requirement("09:00", 1)], [dayOff]).slots[0];
  assert.equal(dayOffResult.assignedChildcareWorkerCount, 0);
  assert.ok(dayOffResult.candidateEvaluations[0].exclusionReasons.includes("PREFERENCE_DAY_OFF"));

  const preferred = staff("B", {
    schedulePreferences: [{
      date: "2026-09-07", preferenceType: "work_time", startTime: "10:00", endTime: "16:00",
    }],
  });
  assert.equal(calculateAutomaticChildcareShift([requirement("10:00", 1)], [preferred])
    .slots[0].assignedChildcareWorkerCount, 1);
  const outsidePreference = calculateAutomaticChildcareShift([requirement("09:45", 1)], [preferred]).slots[0];
  assert.equal(outsidePreference.assignedChildcareWorkerCount, 0);
  assert.ok(outsidePreference.candidateEvaluations[0].exclusionReasons.includes("OUTSIDE_PREFERENCE_TIME"));

  const extendsBasicTime = staff("C", {
    schedulePreferences: [{
      date: "2026-09-07", preferenceType: "work_time", startTime: "08:00", endTime: "17:00",
    }],
  });
  assert.equal(calculateAutomaticChildcareShift([requirement("08:00", 1)], [extendsBasicTime])
    .slots[0].assignedChildcareWorkerCount, 1);
  assert.equal(calculateAutomaticChildcareShift([requirement("08:00", 1)], [staff("D")])
    .slots[0].assignedChildcareWorkerCount, 0);
});

test("prioritizes a daily work-time preference over an otherwise continuing candidate", () => {
  const regular = staff("A", { staffCode: "ST0001" });
  const preferred = staff("B", {
    staffCode: "ST0002",
    schedulePreferences: [{
      date: "2026-09-07",
      preferenceType: "work_time",
      startTime: "10:00",
      endTime: "16:00",
    }],
  });
  const result = calculateAutomaticChildcareShift([
    requirement("09:45", 1),
    requirement("10:00", 1),
  ], [regular, preferred]);
  assert.deepEqual(result.slots[0].assignedStaff.map((entry) => entry.staffId), ["A"]);
  assert.deepEqual(result.slots[1].assignedStaff.map((entry) => entry.staffId), ["B"]);
  assert.equal(result.slots[1].assignedStaff[0].hasWorkTimePreference, true);
});

test("selects exactly one alternative availability candidate from demand and qualifications", () => {
  const date = "2026-09-11";
  const profile = withFridayAvailabilityCandidates(staff("ALT"));
  const morningDemand = calculateAutomaticChildcareShift([
    requirement("10:00", 1, 0, date),
    requirement("10:15", 1, 0, date),
    requirement("15:00", 1, 0, date),
  ], [profile]);
  assert.equal(morningDemand.selectedAvailabilityCandidates[0].candidateId, "friday-morning");
  assert.deepEqual(morningDemand.slots.map((slot) => slot.assignedStaff.length), [1, 1, 0]);

  const afternoonDemand = calculateAutomaticChildcareShift([
    requirement("10:00", 1, 0, date),
    requirement("15:00", 1, 0, date),
    requirement("15:15", 1, 0, date),
    requirement("15:30", 1, 0, date),
  ], [profile]);
  assert.equal(afternoonDemand.selectedAvailabilityCandidates[0].candidateId, "friday-afternoon");
  assert.deepEqual(afternoonDemand.slots.map((slot) => slot.assignedStaff.length), [0, 1, 1, 1]);

  const licensedAfternoon = calculateAutomaticChildcareShift([
    requirement("10:00", 1, 0, date),
    requirement("10:15", 1, 0, date),
    requirement("15:00", 1, 1, date),
  ], [profile]);
  assert.equal(licensedAfternoon.selectedAvailabilityCandidates[0].candidateId, "friday-afternoon");
  assert.deepEqual(licensedAfternoon.slots.map((slot) => slot.assignedStaff.length), [0, 0, 1]);
});

test("coordinates alternative selections across staff instead of concentrating everyone in one period", () => {
  const date = "2026-09-11";
  const profiles = [
    withFridayAvailabilityCandidates(staff("A", { staffCode: "ST0001" })),
    withFridayAvailabilityCandidates(staff("B", { staffCode: "ST0002" })),
  ];
  const slots = [
    requirement("10:00", 1, 0, date),
    requirement("15:00", 1, 0, date),
  ];

  const first = calculateAutomaticChildcareShift(slots, profiles);
  const repeated = calculateAutomaticChildcareShift([...slots].reverse(), [...profiles].reverse());

  assert.deepEqual(first.selectedAvailabilityCandidates.map((entry) => [entry.staffId, entry.candidateId]), [
    ["A", "friday-morning"],
    ["B", "friday-afternoon"],
  ]);
  assert.deepEqual(first.slots.map((slot) => slot.assignedStaff.map((entry) => entry.staffId)), [["A"], ["B"]]);
  assert.deepEqual(first, repeated);
});

test("uses a date-specific work-time preference instead of weekly alternatives", () => {
  const date = "2026-09-11";
  const profile = withFridayAvailabilityCandidates(staff("ALT-PREF", {
    schedulePreferences: [{
      date,
      preferenceType: "work_time",
      startTime: "12:00",
      endTime: "13:00",
    }],
  }));
  const result = calculateAutomaticChildcareShift([
    requirement("10:00", 1, 0, date),
    requirement("12:00", 1, 0, date),
    requirement("15:00", 1, 0, date),
  ], [profile]);
  assert.deepEqual(result.selectedAvailabilityCandidates, []);
  assert.deepEqual(result.slots.map((slot) => slot.assignedStaff.length), [0, 1, 0]);
});

test("allows a sixth work day but excludes seventh days and existing non-work days", () => {
  const sixth = staff("A", {
    scheduledDays: workDays(["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]),
  });
  assert.equal(calculateAutomaticChildcareShift([requirement("09:00", 1)], [sixth])
    .slots[0].assignedChildcareWorkerCount, 1);

  const seventh = staff("A", {
    scheduledDays: workDays(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]),
  });
  const seventhResult = calculateAutomaticChildcareShift([requirement("09:00", 1)], [seventh]).slots[0];
  assert.equal(seventhResult.assignedChildcareWorkerCount, 0);
  assert.ok(seventhResult.candidateEvaluations[0].exclusionReasons.includes("CONSECUTIVE_WORK_LIMIT"));

  const crossing = staff("A", {
    scheduledDays: workDays(["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]),
  });
  const crossingResult = calculateAutomaticChildcareShift(
    [requirement("09:00", 1, 0, "2026-09-04")],
    [crossing],
  ).slots[0];
  assert.equal(crossingResult.assignedChildcareWorkerCount, 0);
  assert.ok(crossingResult.candidateEvaluations[0].exclusionReasons.includes("CONSECUTIVE_WORK_LIMIT"));

  const publicDayOff = staff("A", {
    scheduledDays: [{ staffId: "A", date: "2026-09-07", dayType: "day_off", segments: [] }],
  });
  const protectedResult = calculateAutomaticChildcareShift([requirement("09:00", 1)], [publicDayOff]).slots[0];
  assert.equal(protectedResult.assignedChildcareWorkerCount, 0);
  assert.ok(protectedResult.candidateEvaluations[0].exclusionReasons.includes("EXISTING_NON_WORK_DAY"));

  const otherNonWork = staff("A", {
    scheduledDays: [{ staffId: "A", date: "2026-09-07", dayType: "other", segments: [] }],
  });
  const otherResult = calculateAutomaticChildcareShift([requirement("09:00", 1)], [otherNonWork]).slots[0];
  assert.equal(otherResult.assignedChildcareWorkerCount, 0);
  assert.ok(otherResult.candidateEvaluations[0].exclusionReasons.includes("EXISTING_NON_WORK_DAY"));
});

test("keeps adjacent assignments deterministic without unnecessary staff changes", () => {
  const profiles = [
    staff("A", { staffCode: "ST0001" }),
    staff("B", { staffCode: "ST0002", qualification: "childcare_support_worker_local_childcare" }),
    staff("C", { staffCode: "ST0003", qualification: "childcare_support_worker_local_childcare" }),
  ];
  const requirements = [
    requirement("09:00", 2, 1),
    requirement("09:15", 1, 0),
    requirement("09:30", 2, 1),
  ];
  const first = calculateAutomaticChildcareShift(requirements, profiles);
  const second = calculateAutomaticChildcareShift([...requirements], [...profiles].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(first.slots.map((slot) => slot.assignedStaff.map((entry) => entry.staffId)), [
    ["A", "B"],
    ["A"],
    ["A", "B"],
  ]);
  assert.equal(first.slots[1].assignedStaff[0].continuedFromPreviousSlot, true);
});

test("merges contiguous quarter-hour childcare assignments into work segments", () => {
  const profile = staff("A");
  const result = calculateAutomaticChildcareShift([
    requirement("09:00", 1),
    requirement("09:15", 1),
    requirement("09:30", 0),
    requirement("09:45", 1),
  ], [profile]);
  assert.deepEqual(mergeChildcareAssignmentsIntoSegments(result.slots), [
    {
      staffId: "A",
      staffCode: "STA",
      staffName: "架空 職員A",
      date: "2026-09-07",
      startTime: "09:00",
      endTime: "09:30",
      activityType: "childcare",
    },
    {
      staffId: "A",
      staffCode: "STA",
      staffName: "架空 職員A",
      date: "2026-09-07",
      startTime: "09:45",
      endTime: "10:00",
      activityType: "childcare",
    },
  ]);
});

test("stops automatic work at 480 daily minutes when a break cannot be assumed", () => {
  const date = "2026-09-07";
  const result = calculateAutomaticChildcareShift(
    quarterHourRequirements(date, "09:00", 33),
    [staff("A")],
    {
      workLimitProfiles: [{ staffId: "A", existingDays: [] }],
      breakUnavailableStaffDates: [staffDateWorkKey("A", date)],
    },
  );
  assert.equal(result.slots.reduce((total, slot) => total + slot.assignedChildcareWorkerCount, 0), 32);
  assert.equal(result.slots.at(-1).assignedChildcareWorkerCount, 0);
  assert.ok(result.slots.at(-1).candidateEvaluations[0].exclusionReasons.includes("DAILY_WORK_LIMIT"));
});

test("uses 31-day and 30-day full-time monthly limits while leaving part-time uncapped monthly", () => {
  const profile = staff("A", { availableStartTime: "09:00", availableEndTime: "18:00" });
  const excluded31 = new Set([4, 8, 12, 16, 20, 24, 28, 31]);
  const dates31 = Array.from({ length: 31 }, (_, index) => index + 1)
    .filter((day) => !excluded31.has(day))
    .map((day) => `2026-10-${String(day).padStart(2, "0")}`);
  const slots31 = dates31.flatMap((date) => quarterHourRequirements(date, "09:00", 32));
  const result31 = calculateAutomaticChildcareShift(slots31, [profile], {
    workLimitProfiles: [{
      staffId: "A",
      monthlyLimitMinutes: 176 * 60,
      existingDays: [],
    }],
    breakUnavailableStaffDates: dates31.map((date) => staffDateWorkKey("A", date)),
  });
  assert.equal(result31.slots.reduce((total, slot) => total + slot.assignedChildcareWorkerCount * 15, 0), 176 * 60);
  assert.ok(result31.slots.at(-1).candidateEvaluations[0].exclusionReasons.includes("MONTHLY_WORK_LIMIT"));

  const excluded30 = new Set([4, 8, 12, 16, 20, 24, 28, 30]);
  const dates30 = Array.from({ length: 30 }, (_, index) => index + 1)
    .filter((day) => !excluded30.has(day))
    .map((day) => `2026-09-${String(day).padStart(2, "0")}`);
  const slots30 = dates30.flatMap((date) => quarterHourRequirements(date, "09:00", 32));
  const result30 = calculateAutomaticChildcareShift(slots30, [profile], {
    workLimitProfiles: [{
      staffId: "A",
      monthlyLimitMinutes: 168 * 60,
      existingDays: [],
    }],
    breakUnavailableStaffDates: dates30.map((date) => staffDateWorkKey("A", date)),
  });
  assert.equal(result30.slots.reduce((total, slot) => total + slot.assignedChildcareWorkerCount * 15, 0), 168 * 60);

  const partTime = calculateAutomaticChildcareShift(slots30, [profile], {
    workLimitProfiles: [{ staffId: "A", monthlyLimitMinutes: null, existingDays: [] }],
    breakUnavailableStaffDates: dates30.map((date) => staffDateWorkKey("A", date)),
  });
  assert.equal(partTime.slots.reduce((total, slot) => total + slot.assignedChildcareWorkerCount * 15, 0), 176 * 60);
});
