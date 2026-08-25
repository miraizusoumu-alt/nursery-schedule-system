const AGE_COUNT_KEYS = Object.freeze([
  "zeroYearOldCount",
  "oneYearOldCount",
  "twoYearOldCount",
]);

function freezeRuleSet(ruleSet) {
  return Object.freeze({
    ...ruleSet,
    agePools: Object.freeze(ruleSet.agePools.map((pool) => Object.freeze({
      ...pool,
      countKeys: Object.freeze([...pool.countKeys]),
    }))),
  });
}

export const OFFICIAL_CHILDCARE_STAFFING_RULE_SET = freezeRuleSet({
  id: "official-2026",
  agePools: [
    {
      id: "zero_year_old",
      label: "0歳児",
      countKeys: ["zeroYearOldCount"],
      childrenPerWorker: 3,
    },
    {
      id: "one_two_year_old",
      label: "1・2歳児",
      countKeys: ["oneYearOldCount", "twoYearOldCount"],
      childrenPerWorker: 6,
    },
  ],
  ageBasedAdditionalWorkers: 1,
  totalChildrenPerWorker: 3,
  minimumWorkersWhenChildrenPresent: 2,
  licensedWorkerNumerator: 1,
  licensedWorkerDenominator: 2,
});

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name}は0以上の整数で指定してください。`);
  }
}

function assertRuleSet(ruleSet) {
  if (!ruleSet || !Array.isArray(ruleSet.agePools) || ruleSet.agePools.length === 0) {
    throw new TypeError("配置基準の年齢区分が設定されていません。");
  }
  for (const pool of ruleSet.agePools) {
    if (!Array.isArray(pool.countKeys) || pool.countKeys.length === 0) {
      throw new TypeError("配置基準の年齢区分に人数項目がありません。");
    }
    if (!Number.isInteger(pool.childrenPerWorker) || pool.childrenPerWorker <= 0) {
      throw new TypeError("配置基準の比率が正しくありません。");
    }
    for (const countKey of pool.countKeys) {
      if (!AGE_COUNT_KEYS.includes(countKey)) {
        throw new TypeError(`未対応の年齢別人数項目です: ${countKey}`);
      }
    }
  }
}

function truncatedTenths(numerator, denominator) {
  return Math.floor((numerator * 10) / denominator);
}

function roundedIntegerFromTenths(value) {
  return Math.floor((value + 5) / 10);
}

export function calculateRequiredChildcareStaff(counts, ruleSet = OFFICIAL_CHILDCARE_STAFFING_RULE_SET) {
  const normalizedCounts = {
    zeroYearOldCount: counts?.zeroYearOldCount,
    oneYearOldCount: counts?.oneYearOldCount,
    twoYearOldCount: counts?.twoYearOldCount,
  };
  for (const countKey of AGE_COUNT_KEYS) {
    assertNonNegativeInteger(normalizedCounts[countKey], countKey);
  }
  assertRuleSet(ruleSet);

  const totalChildren = AGE_COUNT_KEYS.reduce((sum, countKey) => sum + normalizedCounts[countKey], 0);
  const agePoolBreakdown = ruleSet.agePools.map((pool) => {
    const childCount = pool.countKeys.reduce((sum, countKey) => sum + normalizedCounts[countKey], 0);
    const calculationTenths = truncatedTenths(childCount, pool.childrenPerWorker);
    return {
      id: pool.id,
      label: pool.label,
      countKeys: [...pool.countKeys],
      childCount,
      childrenPerWorker: pool.childrenPerWorker,
      calculationTenths,
      calculationValue: calculationTenths / 10,
    };
  });

  const ageBasedAdditionalWorkers = totalChildren > 0 ? ruleSet.ageBasedAdditionalWorkers : 0;
  const ageBasedRawTenths = totalChildren > 0
    ? agePoolBreakdown.reduce((sum, pool) => sum + pool.calculationTenths, 0) + ageBasedAdditionalWorkers * 10
    : 0;
  const ageBasedRequirement = totalChildren > 0 ? roundedIntegerFromTenths(ageBasedRawTenths) : 0;
  const totalChildrenRuleRequirement = totalChildren > 0
    ? Math.ceil(totalChildren / ruleSet.totalChildrenPerWorker)
    : 0;
  const minimumStaffRequirement = totalChildren > 0 ? ruleSet.minimumWorkersWhenChildrenPresent : 0;
  const requiredChildcareWorkers = Math.max(
    ageBasedRequirement,
    totalChildrenRuleRequirement,
    minimumStaffRequirement,
  );
  const requiredLicensedNurseryTeachers = requiredChildcareWorkers > 0
    ? Math.ceil((requiredChildcareWorkers * ruleSet.licensedWorkerNumerator) / ruleSet.licensedWorkerDenominator)
    : 0;

  const candidates = {
    age_based: ageBasedRequirement,
    total_children_3_to_1: totalChildrenRuleRequirement,
    minimum_staff: minimumStaffRequirement,
  };
  const appliedRules = totalChildren === 0
    ? []
    : Object.entries(candidates)
        .filter(([, value]) => value === requiredChildcareWorkers)
        .map(([rule]) => rule);

  const poolById = new Map(agePoolBreakdown.map((pool) => [pool.id, pool]));
  const zeroYearOldCalculationValue = poolById.get("zero_year_old")?.calculationValue ?? 0;
  const oneTwoYearOldCalculationValue = poolById.get("one_two_year_old")?.calculationValue ?? 0;

  return {
    ...normalizedCounts,
    totalChildren,
    zeroYearOldCalculationValue,
    oneTwoYearOldCalculationValue,
    zeroYearOldContribution: zeroYearOldCalculationValue,
    oneTwoYearOldContribution: oneTwoYearOldCalculationValue,
    ageBasedAdditionalWorkers,
    ageBasedRawValue: ageBasedRawTenths / 10,
    ageBasedRequirement,
    totalChildrenRuleRequirement,
    totalChildrenThreeToOneRequirement: totalChildrenRuleRequirement,
    minimumStaffRequirement,
    requiredChildcareWorkers,
    requiredLicensedNurseryTeachers,
    requiredMealStaff: null,
    appliedRules,
    calculationBreakdown: {
      ruleSetId: ruleSet.id,
      agePools: agePoolBreakdown,
      ageBased: {
        additionalWorkers: ageBasedAdditionalWorkers,
        rawTenths: ageBasedRawTenths,
        rawValue: ageBasedRawTenths / 10,
        roundedRequirement: ageBasedRequirement,
      },
      totalChildrenRule: {
        totalChildren,
        childrenPerWorker: ruleSet.totalChildrenPerWorker,
        roundedUpRequirement: totalChildrenRuleRequirement,
      },
      minimumStaff: {
        applies: totalChildren > 0,
        requirement: minimumStaffRequirement,
      },
      selection: {
        candidates,
        requiredChildcareWorkers,
        appliedRules,
      },
      licensedNurseryTeachers: {
        numerator: ruleSet.licensedWorkerNumerator,
        denominator: ruleSet.licensedWorkerDenominator,
        roundedUpRequirement: requiredLicensedNurseryTeachers,
      },
    },
  };
}
