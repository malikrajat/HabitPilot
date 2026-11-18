import type {
  BmiCategory,
  BmiResult,
  MovingAveragePoint,
  TrendSeriesPoint,
  WeightPoint,
  WeightTrend,
} from "./types.js";
import { daysBetween, round } from "./dates.js";

export function computeBmi(heightCm: number, weightKg: number): BmiResult | null {
  if (!Number.isFinite(heightCm) || !Number.isFinite(weightKg) || heightCm <= 0 || weightKg <= 0) {
    return null;
  }
  const heightM = heightCm / 100;
  const bmi = round(weightKg / (heightM * heightM), 1);
  let category: BmiCategory;
  if (bmi < 18.5) category = "underweight";
  else if (bmi < 25) category = "healthy-range";
  else if (bmi < 30) category = "above-range";
  else category = "well-above-range";

  return {
    bmi,
    category,
    healthyWeightMinKg: round(18.5 * heightM * heightM, 1),
    healthyWeightMaxKg: round(24.9 * heightM * heightM, 1),
    note: "BMI is a rough screening ratio, not a diagnosis. It ignores muscle mass, age and body composition.",
  };
}

export function sortByDate<T extends { date: string }>(entries: readonly T[]): T[] {
  return [...entries]
    .filter((entry) => Number.isFinite(new Date(entry.date).getTime()))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function latestWeight(entries: readonly WeightPoint[]): WeightPoint | null {
  const sorted = sortByDate(entries);
  return sorted.at(-1) ?? null;
}

export function movingAverage(entries: readonly WeightPoint[], window = 7): MovingAveragePoint[] {
  const sorted = sortByDate(entries);
  const size = Math.max(1, Math.floor(window));
  return sorted.map((entry, index) => {
    const sample = sorted.slice(Math.max(0, index - size + 1), index + 1);
    const average = sample.reduce((sum, item) => sum + item.kg, 0) / sample.length;
    return { ...entry, average: round(average, 2), samples: sample.length };
  });
}

export function buildTrendSeries(entries: readonly WeightPoint[], window = 7): TrendSeriesPoint[] {
  const averaged = movingAverage(entries, window);
  const baseline = averaged[0]?.average ?? 0;
  return averaged.map((point) => ({
    ...point,
    baselineKg: round(baseline, 2),
  }));
}

export interface WeightChange {
  readonly fromDate: string;
  readonly toDate: string;
  readonly fromKg: number;
  readonly toKg: number;
  readonly deltaKg: number;
  readonly percent: number;
}

export function weightChangeOverDays(
  entries: readonly WeightPoint[],
  days: number,
): WeightChange | null {
  const sorted = sortByDate(entries);
  const latest = sorted.at(-1);
  if (!latest || sorted.length < 2) return null;

  const targetDate = new Date(new Date(latest.date).getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const earlier = [...sorted]
    .reverse()
    .find((entry) => entry.date <= targetDate) ?? sorted[0];
  if (!earlier || earlier.date === latest.date) return null;

  const deltaKg = round(latest.kg - earlier.kg, 1);
  return {
    fromDate: earlier.date,
    toDate: latest.date,
    fromKg: earlier.kg,
    toKg: latest.kg,
    deltaKg,
    percent: earlier.kg === 0 ? 0 : round((deltaKg / earlier.kg) * 100, 1),
  };
}

export interface TrendOptions {
  readonly windowDays?: number;
  readonly stableThresholdKgPerWeek?: number;
}

/**
 * Least-squares trend over a bounded recent window. Deterministic and
 * explainable; never presented as a medical prediction.
 */
export function computeWeightTrend(
  entries: readonly WeightPoint[],
  options: TrendOptions = {},
): WeightTrend {
  const windowDays = options.windowDays ?? 28;
  const threshold = options.stableThresholdKgPerWeek ?? 0.1;
  const sorted = sortByDate(entries);
  const latest = sorted.at(-1);

  if (!latest) {
    return {
      direction: "insufficient-data",
      weeklyRateKg: 0,
      totalChangeKg: 0,
      dataPoints: 0,
      spanDays: 0,
      note: "No weight entries yet.",
    };
  }

  const cutoff = new Date(new Date(latest.date).getTime() - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const windowed = sorted.filter((entry) => entry.date >= cutoff);
  const first = windowed[0];
  const spanDays = first ? daysBetween(first.date, latest.date) : 0;

  if (windowed.length < 3 || !Number.isFinite(spanDays) || spanDays < 7) {
    return {
      direction: "insufficient-data",
      weeklyRateKg: 0,
      totalChangeKg: first ? round(latest.kg - first.kg, 1) : 0,
      dataPoints: windowed.length,
      spanDays: Math.max(0, spanDays),
      note: "At least three entries across seven days are needed for a trend.",
    };
  }

  const origin = new Date(first!.date).getTime();
  const xs = windowed.map((entry) => (new Date(entry.date).getTime() - origin) / 86_400_000);
  const ys = windowed.map((entry) => entry.kg);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = (xs[index] ?? 0) - xMean;
    numerator += dx * ((ys[index] ?? 0) - yMean);
    denominator += dx * dx;
  }
  const slopePerDay = denominator === 0 ? 0 : numerator / denominator;
  const weeklyRateKg = round(slopePerDay * 7, 2);

  let direction: WeightTrend["direction"];
  if (Math.abs(weeklyRateKg) < threshold) direction = "stable";
  else if (weeklyRateKg < 0) direction = "losing";
  else direction = "gaining";

  return {
    direction,
    weeklyRateKg,
    totalChangeKg: round((latest.kg - (windowed[0]?.kg ?? latest.kg)), 1),
    dataPoints: windowed.length,
    spanDays,
    note: `Calculated from ${windowed.length} entries over ${spanDays} days. Weight naturally fluctuates day to day.`,
  };
}
