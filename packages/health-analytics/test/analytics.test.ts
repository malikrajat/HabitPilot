import { describe, expect, it } from "vitest";
import {
  buildReminders,
  buildTrendSeries,
  computeBmi,
  computeGoalProgress,
  computeWeightTrend,
  dailySummary,
  eatingDurationStats,
  eatingDurationTrend,
  habitCompletion,
  habitStreak,
  latestWeight,
  movingAverage,
  projectGoal,
  weeklyHabitSummary,
  weeklySummary,
  weightChangeOverDays,
  type WeightPoint,
} from "../src/index.js";

const entries: WeightPoint[] = [
  { date: "2026-10-21", kg: 85.0 },
  { date: "2026-10-28", kg: 84.4 },
  { date: "2026-11-04", kg: 83.9 },
  { date: "2026-11-10", kg: 83.5 },
  { date: "2026-11-17", kg: 83.0 },
];

describe("BMI", () => {
  it("computes a rounded BMI and category", () => {
    const result = computeBmi(178, 83)!;
    expect(result.bmi).toBe(26.2);
    expect(result.category).toBe("above-range");
    expect(result.healthyWeightMinKg).toBe(58.6);
    expect(result.healthyWeightMaxKg).toBe(78.9);
    expect(result.note).toContain("not a diagnosis");
  });

  it("handles invalid input", () => {
    expect(computeBmi(0, 80)).toBeNull();
    expect(computeBmi(170, -1)).toBeNull();
  });
});

describe("weight analytics", () => {
  it("finds the latest entry regardless of input order", () => {
    expect(latestWeight([...entries].reverse())?.kg).toBe(83.0);
  });

  it("computes a trailing moving average", () => {
    const series = movingAverage(
      [
        { date: "2026-11-01", kg: 80 },
        { date: "2026-11-02", kg: 81 },
        { date: "2026-11-03", kg: 79 },
      ],
      2,
    );
    expect(series.map((point) => point.average)).toEqual([80, 80.5, 80]);
    expect(series.map((point) => point.samples)).toEqual([1, 2, 2]);
  });

  it("builds a chart series with a baseline", () => {
    const series = buildTrendSeries(entries, 3);
    expect(series).toHaveLength(5);
    expect(series[0]?.baselineKg).toBe(85);
  });

  it("computes change over a window", () => {
    const change = weightChangeOverDays(entries, 14)!;
    expect(change.fromDate).toBe("2026-10-28");
    expect(change.toDate).toBe("2026-11-17");
    expect(change.deltaKg).toBe(-1.4);
  });

  it("detects a losing trend deterministically", () => {
    const trend = computeWeightTrend(entries);
    expect(trend.direction).toBe("losing");
    expect(trend.weeklyRateKg).toBeLessThan(-0.5);
    expect(trend.dataPoints).toBe(5);
    expect(trend.note).toContain("5 entries");
  });

  it("requires enough data before claiming a trend", () => {
    const trend = computeWeightTrend([
      { date: "2026-11-16", kg: 83 },
      { date: "2026-11-17", kg: 82.9 },
    ]);
    expect(trend.direction).toBe("insufficient-data");
    expect(trend.weeklyRateKg).toBe(0);
  });

  it("classifies a flat trend as stable", () => {
    const flat: WeightPoint[] = [
      { date: "2026-11-01", kg: 80 },
      { date: "2026-11-08", kg: 80.02 },
      { date: "2026-11-15", kg: 80.01 },
    ];
    expect(computeWeightTrend(flat).direction).toBe("stable");
  });
});

describe("goal analytics", () => {
  it("computes goal progress", () => {
    const progress = computeGoalProgress({
      startWeightKg: 90,
      currentWeightKg: 84,
      targetWeightKg: 78,
    });
    expect(progress.direction).toBe("loss");
    expect(progress.progressPercent).toBe(50);
    expect(progress.remainingKg).toBe(6);
    expect(progress.reached).toBe(false);
  });

  it("marks a reached goal at 100 percent", () => {
    const progress = computeGoalProgress({
      startWeightKg: 90,
      currentWeightKg: 77,
      targetWeightKg: 78,
    });
    expect(progress.reached).toBe(true);
    expect(progress.progressPercent).toBe(100);
  });

  it("projects a date but labels it as an estimate", () => {
    const projection = projectGoal({
      currentWeightKg: 83,
      targetWeightKg: 78,
      weeklyRateKg: -0.5,
      fromDate: "2026-11-17",
      dataPoints: 12,
      spanDays: 45,
    });
    expect(projection.kind).toBe("estimate");
    expect(projection.daysRemaining).toBe(70);
    expect(projection.estimatedDate).toBe("2027-01-26");
    expect(projection.confidence).toBe("high");
    expect(projection.disclaimer).toContain("not a medical prediction");
  });

  it("returns no date when the trend moves away from the goal", () => {
    const projection = projectGoal({
      currentWeightKg: 83,
      targetWeightKg: 78,
      weeklyRateKg: 0.2,
      fromDate: "2026-11-17",
    });
    expect(projection.estimatedDate).toBeNull();
    expect(projection.daysRemaining).toBeNull();
  });
});

describe("habit analytics", () => {
  const habit = {
    id: "walk",
    name: "Walk",
    targetPerWeek: 7,
    completedDates: ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"],
  };

  it("computes weekly completion", () => {
    const summary = habitCompletion(habit, "2026-11-11", "2026-11-17");
    expect(summary.completed).toBe(4);
    expect(summary.expected).toBe(7);
    expect(summary.ratePercent).toBe(57.1);
    expect(summary.remaining).toBe(3);
  });

  it("keeps a streak alive when today is still pending", () => {
    const streak = habitStreak(habit.completedDates, "2026-11-18");
    expect(streak.current).toBe(4);
    expect(streak.lastCompletedDate).toBe("2026-11-17");
  });

  it("computes the longest streak", () => {
    const streak = habitStreak(
      ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-10"],
      "2026-11-17",
    );
    expect(streak.current).toBe(0);
    expect(streak.longest).toBe(3);
  });

  it("aggregates habits for a week", () => {
    const summary = weeklyHabitSummary([habit], "2026-11-11", "2026-11-17");
    expect(summary.completed).toBe(4);
  });
});

describe("eating analytics", () => {
  const sessions = [
    { date: "2026-11-10", durationMinutes: 12 },
    { date: "2026-11-11", durationMinutes: 20 },
    { date: "2026-11-16", durationMinutes: 8 },
    { date: "2026-11-17", durationMinutes: 10 },
  ];

  it("computes durations and percentiles", () => {
    const stats = eatingDurationStats(sessions);
    expect(stats.count).toBe(4);
    expect(stats.meanMinutes).toBe(12.5);
    expect(stats.medianMinutes).toBe(11);
    expect(stats.p90Minutes).toBe(20);
    expect(stats.totalMinutes).toBe(50);
  });

  it("compares this week with the previous week", () => {
    const stats = eatingDurationTrend(sessions, "2026-11-17");
    // Recent window (11-11..11-17) averages 12.7 min; previous (11-04..11-10) 12 min.
    expect(stats.trendMinutes).toBe(0.7);
  });

  it("handles no sessions", () => {
    const stats = eatingDurationStats([]);
    expect(stats.count).toBe(0);
    expect(stats.meanMinutes).toBeNull();
  });
});

describe("rule-based reminders", () => {
  it("flags stale weight logs and low hydration deterministically", () => {
    const reminders = buildReminders({
      today: "2026-11-17",
      weightEntries: [{ date: "2026-11-10", kg: 83 }],
      lifestyle: { hydrationMl: 900, sleepHours: 6, steps: 2500 },
      habits: [
        {
          id: "walk",
          name: "Walk",
          targetPerWeek: 7,
          completedDates: ["2026-11-16"],
        },
      ],
    });
    const ids = reminders.map((reminder) => reminder.id);
    expect(ids).toContain("weight-log-gap");
    expect(ids).toContain("hydration-low");
    expect(ids).toContain("sleep-low");
    expect(ids).toContain("steps-low");
    expect(reminders[0]?.severity).toBe("attention");
  });

  it("produces identical output for identical input", () => {
    const input = {
      today: "2026-11-17",
      weightEntries: [{ date: "2026-11-17", kg: 83 }],
      lifestyle: { hydrationMl: 2000, sleepHours: 7.5, steps: 9000 },
    } as const;
    expect(buildReminders(input)).toEqual(buildReminders(input));
  });

  it("adds no AI-generated content", () => {
    const reminders = buildReminders({
      today: "2026-11-17",
      weightEntries: entries,
    });
    expect(reminders.every((reminder) => typeof reminder.rule === "string")).toBe(true);
  });
});

describe("daily and weekly summaries", () => {
  const meals = [
    { date: "2026-11-17", kcal: 500, durationMinutes: 12 },
    { date: "2026-11-17", kcal: 650, durationMinutes: 18 },
    { date: "2026-11-16", kcal: 700, durationMinutes: 25 },
  ];

  it("builds a daily summary without any AI provider", () => {
    const summary = dailySummary({
      date: "2026-11-17",
      weightEntries: entries,
      heightCm: 178,
      lifestyle: { sleepHours: 7.5, hydrationMl: 2000, steps: 9000 },
      meals,
      habits: [
        {
          id: "walk",
          name: "Walk",
          targetPerWeek: 7,
          completedDates: ["2026-11-15", "2026-11-16", "2026-11-17"],
        },
      ],
    });
    expect(summary.generatedBy).toBe("deterministic-analytics");
    expect(summary.latestWeightKg).toBe(83);
    expect(summary.bmi?.bmi).toBe(26.2);
    expect(summary.mealKcal).toBe(1150);
    expect(summary.mealCount).toBe(2);
    expect(summary.habitsCompleted).toBe(3);
    expect(summary.change7dKg).not.toBeNull();
  });

  it("builds a weekly summary with averages", () => {
    const summary = weeklySummary({
      referenceDate: "2026-11-17",
      weightEntries: entries,
      lifestyleDays: [
        { date: "2026-11-16", sleepHours: 7, steps: 8000, hydrationMl: 1800 },
        { date: "2026-11-17", sleepHours: 8, steps: 10000, hydrationMl: 2200 },
      ],
      meals,
    });
    expect(summary.generatedBy).toBe("deterministic-analytics");
    expect(summary.weekStart).toBe("2026-11-11");
    // Only one measurement falls inside this trailing week, so no delta is invented.
    expect(summary.weightStartKg).toBe(83);
    expect(summary.weightEndKg).toBe(83);
    expect(summary.weightChangeKg).toBeNull();
    expect(summary.weeklyTrendKgPerWeek).toBeLessThan(0);
    expect(summary.averageSleepHours).toBe(7.5);
    expect(summary.averageSteps).toBe(9000);
    expect(summary.averageHydrationMl).toBe(2000);
    expect(summary.eating?.count).toBe(3);
  });

  it("returns nulls instead of fabricating values", () => {
    const summary = weeklySummary({ referenceDate: "2026-11-17", weightEntries: [] });
    expect(summary.weightStartKg).toBeNull();
    expect(summary.weeklyTrendKgPerWeek).toBeNull();
    expect(summary.averageSleepHours).toBeNull();
    expect(summary.eating).toBeNull();
  });
});
