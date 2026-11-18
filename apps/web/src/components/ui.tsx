import type { ReactNode } from "react";
import type { DataCategory } from "@habitpilot/consent-core";
import { getCategoryDefinition } from "@habitpilot/consent-core";

export function Card({
  title,
  subtitle,
  actions,
  children,
  tone,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  tone?: "default" | "warning" | "danger" | "success";
}): ReactNode {
  return (
    <section className={`card ${tone ? `card--${tone}` : ""}`}>
      {(title || actions) && (
        <header className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
}): ReactNode {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle__knob" />
    </button>
  );
}

export function CategoryBadge({ category }: { category: DataCategory }): ReactNode {
  const definition = getCategoryDefinition(category);
  const tone =
    definition.sensitivity === "highly-sensitive"
      ? "bad"
      : definition.sensitivity === "sensitive"
        ? "warn"
        : "neutral";
  return <Badge tone={tone}>{definition.sensitivity}</Badge>;
}

export function DisclosureList({ items }: { items: readonly string[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <ul className="disclosure-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ProgressBar({
  percent,
  label,
}: {
  percent: number;
  label: string;
}): ReactNode {
  const safe = Math.max(0, Math.min(100, percent));
  return (
    <div className="progress" role="progressbar" aria-valuenow={safe} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress__fill" style={{ width: `${safe}%` }} />
    </div>
  );
}

export function Sparkline({
  points,
  width = 560,
  height = 160,
  label,
}: {
  points: readonly { date: string; value: number; secondary?: number }[];
  width?: number;
  height?: number;
  label: string;
}): ReactNode {
  if (points.length < 2) {
    return <EmptyState title="Not enough measurements yet">Log at least two entries to draw a trend.</EmptyState>;
  }
  const values = points.flatMap((point) =>
    point.secondary === undefined ? [point.value] : [point.value, point.secondary],
  );
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = 12;
  const span = max - min || 1;

  const toPath = (pick: (point: (typeof points)[number]) => number) =>
    points
      .map((point, index) => {
        const x = padding + (index / (points.length - 1)) * (width - padding * 2);
        const y = height - padding - ((pick(point) - min) / span) * (height - padding * 2);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <path d={toPath((point) => point.value)} className="sparkline__raw" fill="none" />
      {points.some((point) => point.secondary !== undefined) && (
        <path
          d={toPath((point) => point.secondary ?? point.value)}
          className="sparkline__average"
          fill="none"
        />
      )}
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        className="sparkline__axis"
      />
    </svg>
  );
}
