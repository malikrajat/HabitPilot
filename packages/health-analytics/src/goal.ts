import type { EstimateConfidence, GoalProgress, GoalProjection } from "./types.js";
import { addDays, round } from "./dates.js";

export function computeGoalProgress(input: {
  startWeightKg: number;
  currentWeightKg: number;
  targetWeightKg: number;
}): GoalProgress {
  const { startWeightKg, currentWeightKg, targetWeightKg } = input;
  const direction: GoalProgress["direction"] =
    targetWeightKg < startWeightKg ? "loss" : targetWeightKg > startWeightKg ? "gain" : "none";
  const totalDistance = Math.abs(startWeightKg - targetWeightKg);
  const traveled = Math.abs(startWeightKg - currentWeightKg);
  const signedRemaining = direction === "loss"
    ? currentWeightKg - targetWeightKg
    : targetWeightKg - currentWeightKg;
  const reached = signedRemaining <= 0;

  const progressPercent = totalDistance === 0
    ? 100
    : Math.max(0, Math.min(100, round((traveled / totalDistance) * 100, 1)));

  return {
    startWeightKg,
    currentWeightKg,
    targetWeightKg,
    remainingKg: direction === "none" ? 0 : round(Math.max(0, signedRemaining), 1),
    progressPercent: reached ? 100 : progressPercent,
    direction,
    reached,
  };
}

export interface ProjectionInput {
  readonly currentWeightKg: number;
  readonly targetWeightKg: number;
  /** From deterministic trend analysis; positive means gaining. */
  readonly weeklyRateKg: number;
  readonly fromDate: string;
  readonly dataPoints?: number;
  readonly spanDays?: number;
}

const DISCLAIMER =
  "This is a simple linear estimate from recent measurements, not a medical prediction. Real progress is rarely linear.";

/**
 * Projects a goal date from the observed rate. Returns null when the current
 * direction cannot reach the target, instead of inventing a date.
 */
export function projectGoal(input: ProjectionInput): GoalProjection {
  const { currentWeightKg, targetWeightKg, weeklyRateKg, fromDate } = input;
  const delta = currentWeightKg - targetWeightKg; // positive => need to lose
  const needsLoss = delta > 0;

  const confidence: EstimateConfidence = (() => {
    const points = input.dataPoints ?? 0;
    const span = input.spanDays ?? 0;
    if (points >= 10 && span >= 42) return "high";
    if (points >= 5 && span >= 21) return "medium";
    return "low";
  })();

  const unreachable = needsLoss ? weeklyRateKg >= 0 : weeklyRateKg <= 0;
  if (Math.abs(weeklyRateKg) < 0.05 || unreachable) {
    return {
      kind: "estimate",
      estimatedDate: null,
      daysRemaining: null,
      weeklyRateKg,
      confidence,
      basis: "The recent trend does not move toward the target, so no date is estimated.",
      disclaimer: DISCLAIMER,
    };
  }

  const weeksNeeded = Math.abs(delta / weeklyRateKg);
  const daysRemaining = Math.ceil(weeksNeeded * 7);
  return {
    kind: "estimate",
    estimatedDate: addDays(fromDate, daysRemaining),
    daysRemaining,
    weeklyRateKg,
    confidence,
    basis: `Based on ${Math.abs(weeklyRateKg).toFixed(2)} kg/week over the recent measurement window.`,
    disclaimer: DISCLAIMER,
  };
}
