import type { EatingDurationStats } from "./types.js";
import { mean, median, percentile, round } from "./dates.js";

export interface EatingSession {
  readonly date: string;
  readonly durationMinutes: number;
}

function stats(values: readonly number[], trend: number | null): EatingDurationStats {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0);
  const average = mean(clean);
  return {
    count: clean.length,
    meanMinutes: average === null ? null : round(average, 1),
    medianMinutes: clean.length === 0 ? null : round(median(clean)!, 1),
    p90Minutes: clean.length === 0 ? null : round(percentile(clean, 90)!, 1),
    minMinutes: clean.length === 0 ? null : round(Math.min(...clean), 1),
    maxMinutes: clean.length === 0 ? null : round(Math.max(...clean), 1),
    totalMinutes: round(clean.reduce((sum, value) => sum + value, 0), 1),
    trendMinutes: trend === null ? null : round(trend, 1),
  };
}

export function eatingDurationStats(
  sessions: readonly EatingSession[],
): EatingDurationStats {
  return stats(sessions.map((session) => session.durationMinutes), null);
}

/**
 * Compares the most recent 7 days with the 7 days before that. Deterministic
 * and independent of any AI provider.
 */
export function eatingDurationTrend(
  sessions: readonly EatingSession[],
  referenceDate: string,
): EatingDurationStats {
  const toDays = (count: number) => {
    const end = new Date(`${referenceDate}T00:00:00.000Z`).getTime();
    return new Date(end - (count - 1) * 86_400_000).toISOString().slice(0, 10);
  };
  const recentStart = toDays(7);
  const previousEnd = new Date(new Date(`${recentStart}T00:00:00.000Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const previousStart = new Date(new Date(`${previousEnd}T00:00:00.000Z`).getTime() - 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const recent = sessions.filter(
    (session) => session.date >= recentStart && session.date <= referenceDate,
  );
  const previous = sessions.filter(
    (session) => session.date >= previousStart && session.date <= previousEnd,
  );

  const recentMean = mean(recent.map((session) => session.durationMinutes));
  const previousMean = mean(previous.map((session) => session.durationMinutes));
  const trend = recentMean !== null && previousMean !== null ? recentMean - previousMean : null;

  return stats(sessions.map((session) => session.durationMinutes), trend);
}
