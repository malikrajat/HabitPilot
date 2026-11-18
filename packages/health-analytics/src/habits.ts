import type { HabitCompletion, HabitStreak } from "./types.js";
import { addDays, daysBetween, parseIsoDate, round } from "./dates.js";

export interface HabitLike {
  readonly id: string;
  readonly name: string;
  readonly completedDates: readonly string[];
  readonly targetPerWeek: number;
}

function uniqueSorted(dates: readonly string[]): string[] {
  return [...new Set(dates)]
    .filter((date) => Number.isFinite(parseIsoDate(date).getTime()))
    .sort((a, b) => a.localeCompare(b));
}

export function habitCompletion(
  habit: HabitLike,
  fromDate: string,
  toDate: string,
): HabitCompletion {
  const completed = uniqueSorted(habit.completedDates).filter(
    (date) => date >= fromDate && date <= toDate,
  ).length;
  const spanDays = Math.max(1, daysBetween(fromDate, toDate) + 1);
  const weeks = spanDays / 7;
  const expected = Math.max(0, Math.round(habit.targetPerWeek * weeks * 10) / 10);
  const ratePercent = expected === 0 ? 0 : round(Math.min(100, (completed / expected) * 100), 1);

  return {
    habitId: habit.id,
    completed,
    expected,
    ratePercent,
    remaining: Math.max(0, round(expected - completed, 1)),
  };
}

export function habitStreak(
  completedDates: readonly string[],
  today: string,
): HabitStreak {
  const dates = uniqueSorted(completedDates);
  const set = new Set(dates);
  if (dates.length === 0) {
    return { current: 0, longest: 0, lastCompletedDate: null };
  }

  // A streak stays alive if today is still pending and yesterday was completed.
  let cursor = set.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  let longest = 1;
  let run = 1;
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1]!;
    const currentDate = dates[index]!;
    if (daysBetween(previous, currentDate) === 1) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  return {
    current,
    longest: Math.max(longest, current),
    lastCompletedDate: dates.at(-1) ?? null,
  };
}

export function weeklyHabitSummary(
  habits: readonly HabitLike[],
  weekStart: string,
  weekEnd: string,
): { completed: number; expected: number; ratePercent: number } {
  let completed = 0;
  let expected = 0;
  for (const habit of habits) {
    const summary = habitCompletion(habit, weekStart, weekEnd);
    completed += summary.completed;
    expected += summary.expected;
  }
  const ratePercent = expected === 0 ? 0 : round((completed / expected) * 100, 1);
  return { completed, expected: round(expected, 1), ratePercent };
}
