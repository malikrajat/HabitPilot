import { useMemo, type ReactNode } from "react";
import {
  buildTrendSeries,
  computeGoalProgress,
  computeWeightTrend,
  dailySummary,
  eatingDurationTrend,
  habitCompletion,
  habitStreak,
  projectGoal,
  weeklySummary,
} from "@habitpilot/health-analytics";
import { useApp } from "../state/AppProvider.js";
import { toIsoDay } from "../lib/sampleData.js";
import { Badge, Card, EmptyState, ProgressBar, Sparkline } from "../components/ui.js";
import type { Page } from "../navigation.js";

const BMI_LABELS: Record<string, string> = {
  underweight: "Below the reference range",
  "healthy-range": "Inside the reference range",
  "above-range": "Above the reference range",
  "well-above-range": "Well above the reference range",
};

export function Dashboard({ onNavigate }: { onNavigate: (page: Page) => void }): ReactNode {
  const { health, consentState, hosted, activeProvider } = useApp();

  const model = useMemo(() => {
    if (!health) return null;
    const today = toIsoDay(0);
    const entries = health.snapshot.weight?.entries ?? [];
    const latest = entries.at(-1) ?? null;
    const summary = dailySummary({
      date: today,
      weightEntries: entries,
      heightCm: health.heightCm,
      ...(health.snapshot.weight?.goal ? { goal: health.snapshot.weight.goal } : {}),
      ...(health.snapshot.lifestyle ? { lifestyle: health.snapshot.lifestyle } : {}),
      habits: health.habits,
      meals: health.meals,
      eatingSessions: health.eatingSessions,
    });
    const weekly = weeklySummary({
      referenceDate: today,
      weightEntries: entries,
      ...(health.snapshot.weight?.goal ? { goal: health.snapshot.weight.goal } : {}),
      lifestyleDays: health.lifestyleDays,
      habits: health.habits,
      meals: health.meals,
      eatingSessions: health.eatingSessions,
    });
    const trend = computeWeightTrend(entries);
    const start = entries[0]?.kg ?? null;
    const goal = health.snapshot.weight?.goal;
    const progress =
      goal && start !== null && latest
        ? computeGoalProgress({
            startWeightKg: start,
            currentWeightKg: latest.kg,
            targetWeightKg: goal.targetWeightKg,
          })
        : null;
    const projection =
      goal && latest
        ? projectGoal({
            currentWeightKg: latest.kg,
            targetWeightKg: goal.targetWeightKg,
            weeklyRateKg: trend.weeklyRateKg,
            fromDate: today,
            dataPoints: trend.dataPoints,
            spanDays: trend.spanDays,
          })
        : null;
    const series = buildTrendSeries(entries, 7);
    const eating = eatingDurationTrend(health.eatingSessions, today);
    const habits = health.habits.map((habit) => ({
      habit,
      week: habitCompletion(habit, toIsoDay(-6), today),
      streak: habitStreak(habit.completedDates, today),
    }));

    return { today, latest, summary, weekly, trend, progress, projection, series, eating, habits };
  }, [health, hosted]);

  if (!health || !model) {
    return <EmptyState title="Preparing local analytics…">Reading your local database.</EmptyState>;
  }

  const { today, latest, summary, weekly, trend, progress, projection, series, eating, habits } =
    model;

  const grantedCount = consentState.grants.filter(
    (grant) => grant.revokedAt === null && grant.policyVersion === consentState.policyVersion,
  ).length;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Today at a glance</h1>
          <p className="muted">
            {today} · all numbers below are computed on this device.{" "}
            <Badge tone="good">Deterministic · no AI</Badge>
          </p>
        </div>
        <button type="button" className="button button--ghost" onClick={() => onNavigate("privacy")}>
          Privacy &amp; AI ({grantedCount} active grants)
        </button>
      </header>

      <div className="stat-grid">
        <Card title="Latest weight">
          <p className="stat">{latest ? `${latest.kg.toFixed(1)} kg` : "—"}</p>
          <p className="muted">
            {summary.change7dKg === null
              ? "Not enough entries for a 7-day change."
              : `${summary.change7dKg > 0 ? "+" : ""}${summary.change7dKg.toFixed(1)} kg over 7 days`}
          </p>
          <p className="hint">{trend.note}</p>
        </Card>

        <Card title="BMI">
          <p className="stat">{summary.bmi ? summary.bmi.bmi.toFixed(1) : "—"}</p>
          <p className="muted">
            {summary.bmi ? BMI_LABELS[summary.bmi.category] ?? summary.bmi.category : "Add your height to compute BMI."}
          </p>
          <p className="hint">{summary.bmi?.note}</p>
        </Card>

        <Card title="This week">
          <p className="stat">
            {weekly.habitCompletionPercent === null
              ? "—"
              : `${weekly.habitCompletionPercent.toFixed(0)}%`}
          </p>
          <p className="muted">habit completion</p>
          <p className="hint">
            {weekly.averageSleepHours !== null ? `${weekly.averageSleepHours} h sleep` : "No sleep data"} ·{" "}
            {weekly.averageSteps !== null ? `${Math.round(weekly.averageSteps)} steps` : "No step data"}
          </p>
        </Card>

        <Card title="Eating pace">
          <p className="stat">{eating.medianMinutes !== null ? `${eating.medianMinutes} min` : "—"}</p>
          <p className="muted">
            median over {eating.count} session{eating.count === 1 ? "" : "s"}
          </p>
          <p className="hint">
            {eating.trendMinutes === null
              ? "Add sessions this and last week to compare."
              : `${eating.trendMinutes > 0 ? "+" : ""}${eating.trendMinutes} min vs last week`}
          </p>
        </Card>
      </div>

      <Card
        title="Weight trend"
        subtitle="Raw measurements with a 7-entry moving average. Charts are computed locally."
        actions={<Badge tone={trend.direction === "losing" ? "good" : "neutral"}>{trend.direction}</Badge>}
      >
        <Sparkline
          label="Weight trend with moving average"
          points={series.map((point) => ({
            date: point.date,
            value: point.kg,
            secondary: point.average,
          }))}
        />
        <div className="legend">
          <span><i className="swatch swatch--raw" /> daily measurement</span>
          <span><i className="swatch swatch--avg" /> 7-entry average</span>
          <span className="muted">Weekly rate: {trend.weeklyRateKg} kg/week</span>
        </div>
      </Card>

      {progress && (
        <Card title="Goal progress" subtitle="Progress is arithmetic on your own entries.">
          <div className="goal-row">
            <div>
              <p className="stat stat--small">
                {progress.currentWeightKg.toFixed(1)} → {progress.targetWeightKg.toFixed(1)} kg
              </p>
              <p className="muted">
                {progress.remainingKg.toFixed(1)} kg remaining · {progress.progressPercent.toFixed(0)}% of the way
              </p>
            </div>
            <Badge tone={progress.reached ? "good" : "info"}>
              {progress.reached ? "Goal reached" : progress.direction}
            </Badge>
          </div>
          <ProgressBar percent={progress.progressPercent} label="Goal progress" />
          {projection && (
            <div className="estimate">
              <strong>Estimate, not a medical prediction.</strong>{" "}
              {projection.estimatedDate
                ? `At ${projection.weeklyRateKg} kg/week, the target would be reached around ${projection.estimatedDate} (${projection.confidence} confidence).`
                : projection.basis}{" "}
              <span className="muted">{projection.disclaimer}</span>
            </div>
          )}
        </Card>
      )}

      <div className="two-col">
        <Card title="Habits this week">
          <ul className="habit-list">
            {habits.map(({ habit, week, streak }) => (
              <li key={habit.id}>
                <div className="habit-row">
                  <div>
                    <strong>{habit.name}</strong>
                    <p className="muted">
                      {week.completed} / {week.expected} this week · current streak {streak.current}
                    </p>
                  </div>
                  <Badge tone={week.ratePercent >= 80 ? "good" : week.ratePercent >= 40 ? "warn" : "bad"}>
                    {week.ratePercent.toFixed(0)}%
                  </Badge>
                </div>
                <ProgressBar percent={week.ratePercent} label={`${habit.name} completion`} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Rule-based reminders" subtitle="Plain rules over your local data. No model involved.">
          {summary.reminders.length === 0 ? (
            <EmptyState title="Nothing needs attention">No deterministic rule is currently triggered.</EmptyState>
          ) : (
            <ul className="reminder-list">
              {summary.reminders.map((reminder) => (
                <li key={reminder.id}>
                  <Badge tone={reminder.severity === "attention" ? "warn" : "info"}>
                    {reminder.severity}
                  </Badge>
                  <div>
                    <strong>{reminder.title}</strong>
                    <p className="muted">{reminder.detail}</p>
                    <p className="hint">rule: {reminder.rule}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="AI is optional"
        tone={activeProvider ? "default" : "warning"}
        subtitle="Everything above works with no provider and no consent. Language-model help is available only for tasks that need it."
      >
        <div className="row">
          <p className="muted">
            {activeProvider
              ? `Configured provider: ${activeProvider.providerId} (${activeProvider.locality}). Configuration does not grant data access.`
              : "No AI provider is configured. The dashboard remains fully functional."}
          </p>
          <button type="button" className="button" onClick={() => onNavigate("assistant")}>
            Open AI Assistant
          </button>
        </div>
      </Card>
    </div>
  );
}
