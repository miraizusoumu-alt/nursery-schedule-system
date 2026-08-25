import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRequiredChildcareStaff,
  OFFICIAL_CHILDCARE_STAFFING_RULE_SET,
} from "../lib/server/staffing/required-childcare-staff.mjs";

function calculate(zeroYearOldCount, oneYearOldCount, twoYearOldCount, ruleSet) {
  return calculateRequiredChildcareStaff(
    { zeroYearOldCount, oneYearOldCount, twoYearOldCount },
    ruleSet,
  );
}

test("returns zero requirements when no children are present", () => {
  const result = calculate(0, 0, 0);
  assert.equal(result.totalChildren, 0);
  assert.equal(result.ageBasedRequirement, 0);
  assert.equal(result.totalChildrenRuleRequirement, 0);
  assert.equal(result.minimumStaffRequirement, 0);
  assert.equal(result.requiredChildcareWorkers, 0);
  assert.equal(result.requiredLicensedNurseryTeachers, 0);
  assert.deepEqual(result.appliedRules, []);
});

test("applies the two-worker minimum to one through three children", () => {
  for (const childCount of [1, 2, 3]) {
    const result = calculate(0, 0, childCount);
    assert.equal(result.requiredChildcareWorkers, 2, `${childCount}人`);
    assert.equal(result.requiredLicensedNurseryTeachers, 1, `${childCount}人`);
    assert.ok(result.appliedRules.includes("minimum_staff"), `${childCount}人`);
  }
});

test("keeps age-pool division at exact truncated tenths", () => {
  assert.equal(calculate(1, 0, 0).zeroYearOldCalculationValue, 0.3);
  assert.equal(calculate(1, 0, 0).zeroYearOldContribution, 0.3);
  assert.equal(calculate(2, 0, 0).zeroYearOldCalculationValue, 0.6);
  assert.equal(calculate(3, 0, 0).zeroYearOldCalculationValue, 1);
  assert.equal(calculate(4, 0, 0).zeroYearOldCalculationValue, 1.3);
  assert.equal(calculate(0, 1, 0).oneTwoYearOldCalculationValue, 0.1);
  assert.equal(calculate(0, 5, 0).oneTwoYearOldCalculationValue, 0.8);
  assert.equal(calculate(0, 7, 0).oneTwoYearOldCalculationValue, 1.1);
  assert.equal(calculate(0, 7, 0).oneTwoYearOldContribution, 1.1);
});

test("covers the formal total-child examples and three-to-one contribution", () => {
  for (const [totalChildren, expectedRequirement] of [
    [1, 2],
    [2, 2],
    [3, 2],
    [4, 2],
    [6, 2],
    [7, 3],
    [9, 3],
    [10, 4],
    [12, 4],
  ]) {
    const result = calculate(0, 0, totalChildren);
    assert.equal(result.totalChildrenThreeToOneRequirement, Math.ceil(totalChildren / 3), `${totalChildren}人`);
    assert.equal(result.requiredChildcareWorkers, expectedRequirement, `${totalChildren}人`);
  }
});

test("combines one- and two-year-olds before applying the six-to-one ratio", () => {
  for (const [oneYearOldCount, twoYearOldCount, expected] of [
    [2, 3, 0.8],
    [2, 4, 1],
    [3, 4, 1.1],
  ]) {
    assert.equal(calculate(0, oneYearOldCount, twoYearOldCount).oneTwoYearOldCalculationValue, expected);
  }
});

test("covers the formal age-group boundary examples through the final requirement", () => {
  for (const [counts, expected] of [
    [[3, 0, 0], { ageBased: 2, final: 2 }],
    [[4, 0, 0], { ageBased: 2, final: 2 }],
    [[0, 2, 3], { ageBased: 2, final: 2 }],
    [[0, 2, 4], { ageBased: 2, final: 2 }],
    [[0, 3, 4], { ageBased: 2, final: 3 }],
    [[2, 2, 2], { ageBased: 2, final: 2 }],
  ]) {
    const result = calculate(...counts);
    assert.equal(result.ageBasedRequirement, expected.ageBased, counts.join("/"));
    assert.equal(result.requiredChildcareWorkers, expected.final, counts.join("/"));
  }
});

test("rounds the age-based 3.5 requirement up to four", () => {
  const result = calculate(3, 4, 5);
  assert.equal(result.ageBasedRawValue, 3.5);
  assert.equal(result.ageBasedRequirement, 4);
});

test("uses the nursery three-to-one rule when it is the largest requirement", () => {
  const result = calculate(0, 0, 10);
  assert.equal(result.ageBasedRequirement, 3);
  assert.equal(result.totalChildrenRuleRequirement, 4);
  assert.equal(result.minimumStaffRequirement, 2);
  assert.equal(result.requiredChildcareWorkers, 4);
  assert.deepEqual(result.appliedRules, ["total_children_3_to_1"]);
});

test("calculates the formal twelve-child example as four workers and two licensed teachers", () => {
  const result = calculate(3, 4, 5);
  assert.equal(result.totalChildren, 12);
  assert.equal(result.zeroYearOldCalculationValue, 1);
  assert.equal(result.oneTwoYearOldCalculationValue, 1.5);
  assert.equal(result.ageBasedRequirement, 4);
  assert.equal(result.totalChildrenRuleRequirement, 4);
  assert.equal(result.minimumStaffRequirement, 2);
  assert.equal(result.requiredChildcareWorkers, 4);
  assert.equal(result.requiredLicensedNurseryTeachers, 2);
  assert.deepEqual(result.appliedRules, ["age_based", "total_children_3_to_1"]);
  assert.equal(result.requiredMealStaff, null);
});

test("allows a future rule set to separate one- and two-year-old ratios", () => {
  const futureRuleSet = {
    ...OFFICIAL_CHILDCARE_STAFFING_RULE_SET,
    id: "future-one-year-old-five-to-one",
    agePools: [
      OFFICIAL_CHILDCARE_STAFFING_RULE_SET.agePools[0],
      { id: "one_year_old", label: "1歳児", countKeys: ["oneYearOldCount"], childrenPerWorker: 5 },
      { id: "two_year_old", label: "2歳児", countKeys: ["twoYearOldCount"], childrenPerWorker: 6 },
    ],
  };
  const result = calculate(0, 5, 6, futureRuleSet);
  assert.deepEqual(
    result.calculationBreakdown.agePools.map((pool) => [pool.id, pool.calculationValue]),
    [["zero_year_old", 0], ["one_year_old", 1], ["two_year_old", 1]],
  );
});

test("rejects fractional or negative child counts", () => {
  assert.throws(() => calculateRequiredChildcareStaff({ zeroYearOldCount: 0.5, oneYearOldCount: 0, twoYearOldCount: 0 }), TypeError);
  assert.throws(() => calculate(-1, 0, 0), TypeError);
});
