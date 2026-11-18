import type {
  EatingDurationStats,
  LifestyleDay,
  WeeklySummary,
} from "@habitpilot/health-analytics";
import type { HabitRecord, HealthDataSnapshot, MealEntry } from "@habitpilot/consent-core";

export interface LocalHealthData {
  readonly snapshot: HealthDataSnapshot;
  readonly heightCm: number;
  readonly lifestyleDays: readonly LifestyleDay[];
  readonly meals: readonly MealEntry[];
  readonly eatingSessions: readonly { readonly date: string; readonly durationMinutes: number }[];
  readonly habits: readonly HabitRecord[];
}

export interface DashboardModel {
  readonly weekly: WeeklySummary;
  readonly eating: EatingDurationStats;
}

export function toIsoDay(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic demo data. Everything is computed locally; no provider or
 * network call is involved in producing this data.
 */
export function createSampleHealthData(): LocalHealthData {
  const weightEntries = Array.from({ length: 42 }, (_, index) => {
    const daysAgo = 41 - index;
    const trend = 86 - index * 0.07;
    const noise = Math.sin(index * 1.7) * 0.22;
    return {
      date: toIsoDay(-daysAgo),
      kg: Math.round((trend + noise) * 10) / 10,
    };
  });

  const meals: MealEntry[] = [];
  const lifestyleDays: LifestyleDay[] = [];
  const eatingSessions: { date: string; durationMinutes: number }[] = [];

  for (let day = 13; day >= 0; day -= 1) {
    const date = toIsoDay(-day);
    const base = [420, 610, 540];
    const labels = ["breakfast", "lunch", "dinner"];
    labels.forEach((label, index) => {
      const duration = 9 + ((day * 7 + index * 11) % 13);
      meals.push({
        date,
        label,
        kcal: base[index]! + ((day * 37 + index * 53) % 90),
        proteinG: 18 + ((day + index * 4) % 22),
        durationMinutes: duration,
      });
      if (index < 2) eatingSessions.push({ date, durationMinutes: duration });
    });

    lifestyleDays.push({
      date,
      sleepHours: Math.round((6.6 + Math.sin(day / 2) * 0.9) * 10) / 10,
      hydrationMl: 1400 + ((day * 173) % 1200),
      steps: 5200 + ((day * 911) % 7000),
      activeMinutes: 18 + ((day * 13) % 35),
    });
  }

  const observations = {
    eating: Array.from({ length: 8 }, (_, index) => ({
      date: toIsoDay(-index),
      summary: `${11 + (index % 9)} minute meal, ${(0.8 + (index % 5) * 0.1).toFixed(1)} bites/sec`,
      durationMinutes: 11 + (index % 9),
      metrics: { bitesPerMinute: 0.8 + (index % 5) * 0.1 },
      confidence: 0.8,
    })),
    postureEyeScreen: Array.from({ length: 5 }, (_, index) => ({
      date: toIsoDay(-index),
      summary: `${3 + (index % 6)} posture breaks, ${4 + (index % 4)}h screen time`,
      metrics: { breaks: 3 + (index % 6), screenHours: 4 + (index % 4) },
    })),
    breathing: Array.from({ length: 5 }, (_, index) => ({
      date: toIsoDay(-index),
      summary: `resting rate ${13 + (index % 3)}/min during a 5 minute session`,
      durationMinutes: 5,
      metrics: { breathsPerMinute: 13 + (index % 3) },
    })),
  };

  const snapshot: HealthDataSnapshot = {
    profile: {
      ageRange: "30-39",
      biologicalSex: "male",
      heightCm: 178,
      activityLevel: "moderate",
    },
    weight: {
      entries: weightEntries,
      goal: { targetWeightKg: 78, targetDate: toIsoDay(120) },
    },
    nutrition: { meals },
    observations,
    lifestyle: lifestyleDays.at(-1)
      ? {
          sleepHours: lifestyleDays.at(-1)!.sleepHours,
          hydrationMl: lifestyleDays.at(-1)!.hydrationMl,
          steps: lifestyleDays.at(-1)!.steps,
          activeMinutes: lifestyleDays.at(-1)!.activeMinutes,
        }
      : undefined,
  };

  const habits: HabitRecord[] = [
    {
      id: "walk",
      name: "10 minute walk",
      targetPerWeek: 7,
      completedDates: [-1, -2, -3, -5, -6, -8, -9, -10].map(toIsoDay),
    },
    {
      id: "water",
      name: "Hit hydration goal",
      targetPerWeek: 7,
      completedDates: [-1, -2, -4, -5, -7].map(toIsoDay),
    },
    {
      id: "sleep",
      name: "Lights out before 23:00",
      targetPerWeek: 5,
      completedDates: [-2, -3, -4, -6, -8].map(toIsoDay),
    },
  ];

  return {
    snapshot,
    heightCm: 178,
    lifestyleDays,
    meals,
    eatingSessions,
    habits,
  };
}
