import assert from "node:assert/strict";
import test from "node:test";
import {
  planAutomaticBreaks,
  reserveAutomaticBreakCoverage,
} from "../lib/server/staffing/automatic-break-planner.mjs";
import { calculateIntegratedMonthlyAutomaticShift } from "../lib/server/staffing/integrated-monthly-shift-generator.mjs";
import { evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot } from "../lib/server/staffing/staff-eligibility.mjs";
import {
  resolveDailyBreakRequirements,
  resolveRequiredBreakMinutes,
} from "../lib/server/staffing/break-requirements.mjs";
import { calculateDailyScheduledWorkMinutes } from "../lib/server/staffing/scheduled-work.mjs";

function addMinutes(time, amount) {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + amount;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function requirements(startTime, endTime, options = {}) {
  const result = [];
  for (let time = startTime; time < endTime; time = addMinutes(time, 15)) {
    result.push({
      date: options.date ?? "2026-09-07",
      startTime: time,
      endTime: addMinutes(time, 15),
      requiredChildcareWorkers: options.requiredChildcareWorkers ?? 2,
      requiredLicensedNurseryTeachers: options.requiredLicensedNurseryTeachers ?? 0,
    });
  }
  return result;
}

function scheduleDay(staffId, date, dayType = "work", segments = []) {
  return { staffId, date, dayType, segments };
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
    validQualifications: qualification
      ? [{ type: qualification, validFrom: "2026-01-01", validTo: null }]
      : [],
    nationalHolidays: options.nationalHolidays ?? [],
    workConditions: [{
      id: `condition-${id}`,
      validFrom: "2026-01-01",
      validTo: null,
      employmentType: options.employmentType ?? "常勤",
      ...(options.workCondition ?? {}),
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

function manualPlacement(requirementSlots, staffProfiles, assignedStaffIds) {
  const counts = new Map(staffProfiles.map((profile) => [profile.id, 0]));
  const slots = requirementSlots.map((slot, index) => {
    const ids = typeof assignedStaffIds === "function" ? assignedStaffIds(slot, index) : assignedStaffIds;
    const assignedStaff = ids.map((staffId) => {
      const profile = staffProfiles.find((entry) => entry.id === staffId);
      const evaluation = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(profile, slot);
      counts.set(staffId, counts.get(staffId) + 15);
      return evaluation;
    });
    const licensed = assignedStaff.filter((entry) => entry.isLicensedNurseryTeacher).length;
    return {
      ...slot,
      assignedChildcareWorkerCount: assignedStaff.length,
      assignedLicensedNurseryTeacherCount: licensed,
      assignedStaff,
      childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - assignedStaff.length),
      licensedNurseryTeacherShortage: Math.max(0, slot.requiredLicensedNurseryTeachers - licensed),
      candidateEvaluations: [],
    };
  });
  return {
    slots,
    staffWorkloads: staffProfiles
      .filter((profile) => profile.workConditions[0].employmentType === "常勤")
      .map((profile) => ({
        staffId: profile.id,
        initialScheduledWorkMinutes: 0,
        generatedScheduledWorkMinutes: counts.get(profile.id),
        scheduledWorkMinutes: counts.get(profile.id),
        basicScheduledWorkMinutes: 168 * 60,
        progressRatio: counts.get(profile.id) / (168 * 60),
      })),
  };
}

test("does not create a break when no break is required", () => {
  const profiles = [staff("A"), staff("B")];
  const slots = requirements("11:00", "12:00");
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 0 }],
  });
  assert.deepEqual(result.breakSegments, []);
  assert.equal(result.breakOutcomes[0].placementStatus, "not_required");
  assert.equal(result.breakOutcomes[0].placementSucceeded, true);
});

test("resolves statutory minimum break minutes at exact work-time boundaries", () => {
  assert.equal(resolveRequiredBreakMinutes(0), 0);
  assert.equal(resolveRequiredBreakMinutes(360), 0);
  assert.equal(resolveRequiredBreakMinutes(361), 45);
  assert.equal(resolveRequiredBreakMinutes(480), 45);
  assert.equal(resolveRequiredBreakMinutes(481), 60);
});

test("derives daily break requirements from scheduled work without counting break segments", () => {
  const requirements = resolveDailyBreakRequirements([
    {
      staffId: "A",
      date: "2026-09-07",
      startTime: "09:00",
      endTime: "15:15",
      activityType: "childcare",
    },
    {
      staffId: "A",
      date: "2026-09-07",
      startTime: "15:15",
      endTime: "16:15",
      activityType: "break",
    },
  ]);
  assert.deepEqual(requirements, [{
    staffId: "A",
    date: "2026-09-07",
    scheduledWorkMinutes: 375,
    requiredBreakMinutes: 45,
  }]);
});

test("places a continuous 60-minute break with one stable relief worker and updates work minutes", () => {
  const profiles = [staff("A"), staff("B"), staff("C")];
  const slots = requirements("11:00", "14:00");
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  const outcome = result.breakOutcomes[0];
  assert.equal(outcome.placementSucceeded, true);
  assert.equal(outcome.breakStartTime, "12:00");
  assert.equal(outcome.breakEndTime, "13:00");
  assert.deepEqual(outcome.reliefStaffIds, ["C"]);
  assert.deepEqual(result.reliefAssignments, [{
    staffId: "C",
    staffCode: "STC",
    staffName: "架空 職員C",
    reliefForStaffId: "A",
    date: "2026-09-07",
    startTime: "12:00",
    endTime: "13:00",
    activityType: "childcare",
    source: "break_relief",
  }]);
  assert.equal(result.shortagesAfterBreaks.length, 0);
  assert.ok(result.placement.slots.every((slot) => slot.assignedChildcareWorkerCount === 2));
  assert.equal(result.staffWorkloads.find((entry) => entry.staffId === "A").scheduledWorkMinutes, 120);
  assert.equal(result.staffWorkloads.find((entry) => entry.staffId === "C").scheduledWorkMinutes, 60);
  const staffASegments = result.scheduleSegments.filter((segment) => segment.staffId === "A");
  assert.equal(calculateDailyScheduledWorkMinutes(staffASegments), 120);
});

test("places a continuous 45-minute break in fifteen-minute slots", () => {
  const profiles = [staff("A"), staff("B"), staff("C")];
  const slots = requirements("11:00", "14:00");
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 45 }],
  });
  const outcome = result.breakOutcomes[0];
  const duration = (() => {
    const [startHours, startMinutes] = outcome.breakStartTime.split(":").map(Number);
    const [endHours, endMinutes] = outcome.breakEndTime.split(":").map(Number);
    return endHours * 60 + endMinutes - startHours * 60 - startMinutes;
  })();
  assert.equal(duration, 45);
  assert.equal(result.breakSegments[0].activityType, "break");
  assert.equal(result.reliefAssignments[0].endTime, outcome.breakEndTime);
});

test("reserves reciprocal 45-minute breaks without adding staff or short childcare fragments", () => {
  const profiles = [staff("A"), staff("B", { staffCode: "ST0002" })];
  const slots = [
    ...requirements("07:00", "12:00", { requiredChildcareWorkers: 1, requiredLicensedNurseryTeachers: 1 }),
    ...requirements("12:00", "15:00", { requiredChildcareWorkers: 2, requiredLicensedNurseryTeachers: 2 }),
    ...requirements("15:00", "20:00", { requiredChildcareWorkers: 1, requiredLicensedNurseryTeachers: 1 }),
  ];
  const placement = manualPlacement(slots, profiles, (slot) => {
    if (slot.startTime < "12:00") return ["A"];
    if (slot.startTime < "15:00") return ["A", "B"];
    return ["B"];
  });
  const breakRequirements = [
    { staffId: "A", date: "2026-09-07", requiredBreakMinutes: 45 },
    { staffId: "B", date: "2026-09-07", requiredBreakMinutes: 45 },
  ];
  const prepared = reserveAutomaticBreakCoverage({
    requirementSlots: slots,
    placement,
    staffProfiles: profiles,
    breakRequirements,
  });
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: prepared.placement,
    staffProfiles: profiles,
    breakRequirements,
    reservedBreaks: prepared.reservations,
  });
  assert.equal(prepared.reservations.length, 2);
  assert.equal(prepared.reassignments.length, 6);
  assert.equal(result.breakOutcomes.every((outcome) => outcome.placementSucceeded), true);
  assert.equal(result.breakOutcomes.every((outcome) => outcome.reliefRequired), true);
  assert.equal(result.shortagesAfterBreaks.length, 0);
  assert.equal(result.placement.slots.every((slot) => {
    return slot.assignedChildcareWorkerCount === slot.requiredChildcareWorkers
      && slot.assignedLicensedNurseryTeacherCount === slot.requiredLicensedNurseryTeachers;
  }), true);
  assert.equal(result.childcareSegments.some((segment) => {
    const [startHours, startMinutes] = segment.startTime.split(":").map(Number);
    const [endHours, endMinutes] = segment.endTime.split(":").map(Number);
    return endHours * 60 + endMinutes - startHours * 60 - startMinutes <= 30;
  }), false);
  const repeated = reserveAutomaticBreakCoverage({
    requirementSlots: [...slots].reverse(),
    placement: manualPlacement([...slots].reverse(), [...profiles].reverse(), (slot) => {
      if (slot.startTime < "12:00") return ["A"];
      if (slot.startTime < "15:00") return ["A", "B"];
      return ["B"];
    }),
    staffProfiles: [...profiles].reverse(),
    breakRequirements: [...breakRequirements].reverse(),
  });
  assert.deepEqual(repeated.reservations, prepared.reservations);
});

test("reserves reciprocal continuous 60-minute breaks while keeping daily work at 480 minutes", () => {
  const profiles = [staff("A"), staff("B", { staffCode: "ST0002" })];
  const slots = [
    ...requirements("06:30", "12:30", { requiredChildcareWorkers: 1 }),
    ...requirements("12:30", "14:30", { requiredChildcareWorkers: 2 }),
    ...requirements("14:30", "20:30", { requiredChildcareWorkers: 1 }),
  ];
  const placement = manualPlacement(slots, profiles, (slot) => {
    if (slot.startTime < "12:30") return ["A"];
    if (slot.startTime < "14:30") return ["A", "B"];
    return ["B"];
  });
  const breakRequirements = [
    { staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 },
    { staffId: "B", date: "2026-09-07", requiredBreakMinutes: 60 },
  ];
  const prepared = reserveAutomaticBreakCoverage({
    requirementSlots: slots,
    placement,
    staffProfiles: profiles,
    breakRequirements,
  });
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: prepared.placement,
    staffProfiles: profiles,
    breakRequirements,
    reservedBreaks: prepared.reservations,
  });
  assert.equal(prepared.reservations.length, 2);
  assert.equal(result.breakOutcomes.every((outcome) => outcome.placementSucceeded), true);
  for (const profile of profiles) {
    assert.equal(calculateDailyScheduledWorkMinutes(
      result.scheduleSegments.filter((segment) => segment.staffId === profile.id),
    ), 480);
  }
});

test("does not reserve a break through a replacement blocked by preferences, protected leave, or a seventh day", () => {
  const previousSixDays = Array.from({ length: 6 }, (_, index) => {
    return scheduleDay("B", `2026-09-${String(index + 1).padStart(2, "0")}`);
  });
  const slots = [
    ...requirements("07:00", "12:00", { requiredChildcareWorkers: 1 }),
    ...requirements("12:00", "15:00", { requiredChildcareWorkers: 2 }),
    ...requirements("15:00", "20:00", { requiredChildcareWorkers: 1 }),
  ];
  const breakRequirements = [
    { staffId: "A", date: "2026-09-07", requiredBreakMinutes: 45 },
    { staffId: "B", date: "2026-09-07", requiredBreakMinutes: 45 },
  ];
  for (const restricted of [
    staff("B", {
      staffCode: "ST0002",
      schedulePreferences: [{ date: "2026-09-07", preferenceType: "day_off" }],
    }),
    staff("B", {
      staffCode: "ST0002",
      schedulePreferences: [{
        date: "2026-09-07", preferenceType: "work_time", startTime: "12:00", endTime: "20:00",
      }],
    }),
    staff("B", {
      staffCode: "ST0002",
      scheduledDays: [scheduleDay("B", "2026-09-07", "day_off")],
    }),
    staff("B", {
      staffCode: "ST0002",
      scheduledDays: [scheduleDay("B", "2026-09-07", "paid_leave")],
    }),
    staff("B", { staffCode: "ST0002", scheduledDays: previousSixDays }),
  ]) {
    const profiles = [staff("A"), restricted];
    const placement = manualPlacement(slots, profiles, (slot) => {
      if (slot.startTime < "12:00") return ["A"];
      if (slot.startTime < "15:00") return ["A", "B"];
      return ["B"];
    });
    const prepared = reserveAutomaticBreakCoverage({
      requirementSlots: slots,
      placement,
      staffProfiles: profiles,
      breakRequirements,
    });
    assert.deepEqual(prepared.reservations, []);
    assert.deepEqual(prepared.reassignments, []);
  }
});

test("uses existing staffing margin before adding a relief assignment", () => {
  const profiles = [staff("A"), staff("B"), staff("C")];
  const slots = requirements("11:00", "14:00");
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B", "C"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.equal(result.breakOutcomes[0].placementSucceeded, true);
  assert.equal(result.breakOutcomes[0].reliefRequired, false);
  assert.deepEqual(result.reliefAssignments, []);
  assert.ok(result.placement.slots.every((slot) => slot.assignedChildcareWorkerCount === 2
    || slot.assignedChildcareWorkerCount === 3));
});

test("uses a licensed relief worker when a licensed teacher takes a break", () => {
  const profiles = [
    staff("A", { staffCode: "ST0001" }),
    staff("B", { staffCode: "ST0002", qualification: "childcare_support_worker_local_childcare" }),
    staff("C", { staffCode: "ST0004" }),
    staff("D", { staffCode: "ST0003", qualification: "childcare_support_worker_local_childcare" }),
  ];
  const slots = requirements("11:00", "14:00", { requiredLicensedNurseryTeachers: 1 });
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.deepEqual(result.breakOutcomes[0].reliefStaffIds, ["C"]);
  assert.ok(result.placement.slots.every((slot) => slot.assignedLicensedNurseryTeacherCount >= 1));
  assert.equal(result.shortagesAfterBreaks.length, 0);
});

test("does not use a holiday-unavailable worker as break relief", () => {
  const nationalHolidays = [{
    holidayDate: "2026-08-11",
    name: "山の日",
    source: "cabinet_office_japan",
  }];
  const profiles = [
    staff("A", { nationalHolidays }),
    staff("B", { nationalHolidays }),
    staff("C", {
      nationalHolidays,
      workCondition: { holidayWorkAllowed: false },
    }),
  ];
  const slots = requirements("11:00", "14:00", { date: "2026-08-11" });
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-08-11", requiredBreakMinutes: 60 }],
  });
  assert.equal(result.breakOutcomes[0].placementSucceeded, false);
  assert.deepEqual(result.breakOutcomes[0].reliefStaffIds, []);
  assert.deepEqual(result.reliefAssignments, []);
});

test("keeps a relief worker inside the availability candidate selected for that day", () => {
  const profiles = [staff("A"), staff("B"), staff("C")];
  const mondayAvailability = profiles[2].workConditions[0].availability.find((entry) => entry.weekday === 1);
  mondayAvailability.startTime = "09:00";
  mondayAvailability.endTime = "14:00";
  mondayAvailability.candidates = [
    {
      candidateId: "C-morning",
      candidateOrder: 1,
      startTime: "09:00",
      endTime: "11:00",
      weekOrdinals: [1, 2, 3, 4, 5],
    },
    {
      candidateId: "C-afternoon",
      candidateOrder: 2,
      startTime: "12:00",
      endTime: "14:00",
      weekOrdinals: [1, 2, 3, 4, 5],
    },
  ];
  const slots = requirements("12:00", "13:00");
  const placement = manualPlacement(slots, profiles, ["A", "B"]);
  placement.selectedAvailabilityCandidates = [{
    staffId: "C",
    date: "2026-09-07",
    candidateId: "C-morning",
  }];

  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement,
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });

  assert.equal(result.breakOutcomes[0].placementSucceeded, false);
  assert.equal(result.breakOutcomes[0].unresolvedReasonCode, "BREAK_COVERAGE_UNAVAILABLE");
  assert.deepEqual(result.reliefAssignments, []);
});

test("rejects day-off, outside-preference, and seventh-day relief candidates", () => {
  const previousSix = Array.from({ length: 6 }, (_, index) => {
    return scheduleDay("E", `2026-09-${String(index + 1).padStart(2, "0")}`);
  });
  const profiles = [
    staff("A"),
    staff("B"),
    staff("C", {
      schedulePreferences: [{
        date: "2026-09-07", preferenceType: "day_off", startTime: null, endTime: null,
      }],
    }),
    staff("D", {
      schedulePreferences: [{
        date: "2026-09-07", preferenceType: "work_time", startTime: "15:00", endTime: "16:00",
      }],
    }),
    staff("E", { scheduledDays: previousSix }),
    staff("F"),
  ];
  const slots = requirements("11:00", "14:00");
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.deepEqual(result.breakOutcomes[0].reliefStaffIds, ["F"]);
});

test("uses the lower full-time work progress when relief candidates are otherwise equal", () => {
  const profiles = [staff("A"), staff("B"), staff("C"), staff("D")];
  const slots = requirements("11:00", "14:00");
  const placement = manualPlacement(slots, profiles, ["A", "B"]);
  const highProgress = placement.staffWorkloads.find((entry) => entry.staffId === "C");
  highProgress.initialScheduledWorkMinutes = 120 * 60;
  highProgress.scheduledWorkMinutes = 120 * 60;
  highProgress.progressRatio = 120 / 168;
  const lowProgress = placement.staffWorkloads.find((entry) => entry.staffId === "D");
  lowProgress.initialScheduledWorkMinutes = 80 * 60;
  lowProgress.scheduledWorkMinutes = 80 * 60;
  lowProgress.progressRatio = 80 / 168;
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement,
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.deepEqual(result.breakOutcomes[0].reliefStaffIds, ["D"]);
  assert.equal(result.staffWorkloads.find((entry) => entry.staffId === "D").reliefChildcareMinutes, 60);
});

test("avoids concentrating generated breaks at the same time", () => {
  const profiles = [staff("A"), staff("B"), staff("C"), staff("D")];
  const slots = requirements("11:00", "15:00");
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [
      { staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 },
      { staffId: "B", date: "2026-09-07", requiredBreakMinutes: 60 },
    ],
  });
  assert.equal(result.breakOutcomes.every((outcome) => outcome.placementSucceeded), true);
  assert.notEqual(result.breakOutcomes[0].breakStartTime, result.breakOutcomes[1].breakStartTime);
  assert.equal(result.shortagesAfterBreaks.length, 0);
});

test("preserves an existing break without moving or duplicating it", () => {
  const existingDay = scheduleDay("A", "2026-09-07", "work", [
    { startTime: "09:00", endTime: "12:00", activityType: "childcare" },
    { startTime: "12:00", endTime: "13:00", activityType: "break" },
    { startTime: "13:00", endTime: "17:00", activityType: "childcare" },
  ]);
  const profiles = [staff("A", { scheduledDays: [existingDay] }), staff("B"), staff("C")];
  const slots = requirements("12:00", "13:00");
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement: manualPlacement(slots, profiles, ["A", "B"]),
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.equal(result.breakOutcomes[0].placementStatus, "preserved_existing");
  assert.equal(result.breakOutcomes[0].breakStartTime, "12:00");
  assert.equal(result.breakOutcomes[0].breakEndTime, "13:00");
  assert.equal(result.breakSegments.length, 1);
  assert.equal(result.breakSegments[0].source, "existing");
  assert.ok(result.placement.slots.every((slot) => !slot.assignedStaff.some((entry) => entry.staffId === "A")));
});

test("returns clear unresolved reasons instead of violating coverage rules", () => {
  const genericProfiles = [staff("A"), staff("B")];
  const genericSlots = requirements("12:00", "13:00");
  const generic = planAutomaticBreaks({
    requirementSlots: genericSlots,
    placement: manualPlacement(genericSlots, genericProfiles, ["A", "B"]),
    staffProfiles: genericProfiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.equal(generic.breakOutcomes[0].placementSucceeded, false);
  assert.equal(generic.breakOutcomes[0].unresolvedReasonCode, "BREAK_COVERAGE_UNAVAILABLE");
  assert.deepEqual(generic.breakSegments, []);

  const qualifiedProfiles = [
    staff("A"),
    staff("B", { qualification: "childcare_support_worker_local_childcare" }),
    staff("C", { qualification: "childcare_support_worker_local_childcare" }),
  ];
  const qualifiedSlots = requirements("12:00", "13:00", { requiredLicensedNurseryTeachers: 1 });
  const qualified = planAutomaticBreaks({
    requirementSlots: qualifiedSlots,
    placement: manualPlacement(qualifiedSlots, qualifiedProfiles, ["A", "B"]),
    staffProfiles: qualifiedProfiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.equal(qualified.breakOutcomes[0].unresolvedReasonCode, "QUALIFIED_BREAK_COVERAGE_UNAVAILABLE");
  assert.ok(qualified.placement.slots.every((slot) => slot.assignedStaff.some((entry) => entry.staffId === "A")));
});

test("reports when a continuous break interval is not present in the generated work", () => {
  const profiles = [staff("A"), staff("B"), staff("C")];
  const slots = requirements("12:00", "13:00");
  const placement = manualPlacement(slots, profiles, (_slot, index) => {
    return index < 3 ? ["A", "B"] : ["B"];
  });
  const result = planAutomaticBreaks({
    requirementSlots: slots,
    placement,
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date: "2026-09-07", requiredBreakMinutes: 60 }],
  });
  assert.equal(result.breakOutcomes[0].placementSucceeded, false);
  assert.equal(result.breakOutcomes[0].unresolvedReasonCode, "CONTIGUOUS_BREAK_UNAVAILABLE");
  assert.deepEqual(result.breakSegments, []);
});

test("integrates break planning into the monthly engine and remains deterministic", () => {
  const date = "2026-09-20";
  const profiles = [
    staff("A", { staffCode: "ST0001", scheduledDays: [scheduleDay("A", date)] }),
    staff("B", { staffCode: "ST0002", scheduledDays: [scheduleDay("B", date)] }),
    staff("C", { staffCode: "ST0003", scheduledDays: [scheduleDay("C", date)] }),
  ];
  const slots = requirements("09:00", "17:15", { date, requiredChildcareWorkers: 1 });
  const input = {
    targetMonth: "2026-09",
    requirementSlots: slots,
    staffProfiles: profiles,
  };
  const first = calculateIntegratedMonthlyAutomaticShift(input);
  const second = calculateIntegratedMonthlyAutomaticShift({
    ...input,
    requirementSlots: [...slots].reverse(),
    staffProfiles: [...profiles].reverse(),
  });
  assert.deepEqual(first, second);
  assert.equal(first.breakPlan.breakOutcomes[0].placementSucceeded, true);
  assert.equal(first.breakPlan.breakOutcomes[0].requiredBreakMinutes, 60);
  assert.equal(first.breakSegments.length, 1);
  assert.equal(first.shortages.length, 0);
});

test("uses a sufficient existing break without generating an additional break", () => {
  const date = "2026-09-21";
  const existingBreak = { startTime: "12:00", endTime: "13:00", activityType: "break" };
  const profiles = [
    staff("A", {
      staffCode: "ST0001",
      scheduledDays: [scheduleDay("A", date, "work", [existingBreak])],
    }),
    staff("B", { staffCode: "ST0002", scheduledDays: [scheduleDay("B", date)] }),
  ];
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    requirementSlots: requirements("09:00", "17:15", { date, requiredChildcareWorkers: 1 }),
    staffProfiles: profiles,
  });
  const outcome = result.breakPlan.breakOutcomes.find((entry) => entry.staffId === "A");
  assert.equal(outcome.requiredBreakMinutes, 60);
  assert.equal(outcome.placementStatus, "preserved_existing");
  assert.equal(outcome.breakStartTime, "12:00");
  assert.equal(outcome.breakEndTime, "13:00");
  assert.equal(result.breakSegments.filter((segment) => segment.staffId === "A").length, 1);
  assert.equal(result.breakSegments.find((segment) => segment.staffId === "A").source, "existing");
});

test("leaves an insufficient existing break unresolved without generating a split remainder", () => {
  const date = "2026-09-22";
  const existingBreak = { startTime: "12:00", endTime: "12:45", activityType: "break" };
  const profiles = [
    staff("A", {
      staffCode: "ST0001",
      scheduledDays: [scheduleDay("A", date, "work", [existingBreak])],
    }),
    staff("B", { staffCode: "ST0002", scheduledDays: [scheduleDay("B", date)] }),
  ];
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    requirementSlots: requirements("09:00", "17:15", { date, requiredChildcareWorkers: 1 }),
    staffProfiles: profiles,
  });
  const outcome = result.breakPlan.breakOutcomes.find((entry) => entry.staffId === "A");
  assert.equal(outcome.requiredBreakMinutes, 60);
  assert.equal(outcome.placementSucceeded, false);
  assert.equal(outcome.unresolvedReasonCode, "CONTIGUOUS_BREAK_UNAVAILABLE");
  assert.equal(result.breakSegments.filter((segment) => segment.staffId === "A").length, 1);
  assert.equal(result.breakSegments.find((segment) => segment.staffId === "A").source, "existing");
});

test("does not use part-time relief workers beyond weekly limits or below their daily minimum", () => {
  const date = "2026-09-10";
  const contract = {
    weeklyMinutesLimit: 12 * 60,
    weeklyMinutesLimitType: "inclusive",
    preferredWeeklyWorkDaysMin: 1,
    weeklyWorkDaysMax: 3,
    dailyWorkMinutesMin: 3 * 60,
    dailyWorkMinutesMax: 5 * 60,
  };
  const profiles = [
    staff("A"),
    staff("B"),
    staff("C", { employmentType: "非常勤", workCondition: contract }),
  ];
  const slots = requirements("11:00", "14:00", { date });
  const weeklyLimitedPlacement = manualPlacement(slots, profiles, ["A", "B"]);
  weeklyLimitedPlacement.automaticWorkLimitProfiles = [{
    staffId: "C",
    targetMonth: "2026-09",
    dailyLimitMinutes: 480,
    monthlyLimitMinutes: null,
    workConditions: profiles[2].workConditions,
    schedulePreferences: [],
    existingDays: [
      { date: "2026-09-07", scheduledWorkMinutes: 240, breakMinutes: 0 },
      { date: "2026-09-08", scheduledWorkMinutes: 240, breakMinutes: 0 },
      { date: "2026-09-09", scheduledWorkMinutes: 240, breakMinutes: 0 },
    ],
  }];
  const weeklyLimited = planAutomaticBreaks({
    requirementSlots: slots,
    placement: weeklyLimitedPlacement,
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date, requiredBreakMinutes: 60 }],
  });
  assert.equal(weeklyLimited.breakOutcomes[0].placementSucceeded, false);
  assert.equal(weeklyLimited.breakOutcomes[0].unresolvedReasonCode, "BREAK_COVERAGE_UNAVAILABLE");

  const minimumPlacement = manualPlacement(slots, profiles, ["A", "B"]);
  minimumPlacement.automaticWorkLimitProfiles = [{
    staffId: "C",
    targetMonth: "2026-09",
    dailyLimitMinutes: 480,
    monthlyLimitMinutes: null,
    workConditions: profiles[2].workConditions,
    schedulePreferences: [],
    existingDays: [],
  }];
  const belowMinimum = planAutomaticBreaks({
    requirementSlots: slots,
    placement: minimumPlacement,
    staffProfiles: profiles,
    breakRequirements: [{ staffId: "A", date, requiredBreakMinutes: 60 }],
  });
  assert.equal(belowMinimum.breakOutcomes[0].placementSucceeded, false);
  assert.equal(belowMinimum.breakOutcomes[0].unresolvedReasonCode, "BREAK_COVERAGE_UNAVAILABLE");
});
