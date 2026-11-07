import { ratioOf } from "../../utils/albumStatistics";

export interface StackedBarSegment {
  key: string;
  value: number;
  label: string;
  /** Background color utility (e.g. `bg-primary`). */
  colorClass: string;
}

interface StackedBarProps {
  segments: StackedBarSegment[];
  ariaLabel: string;
}

export function StackedBar({ segments, ariaLabel }: StackedBarProps) {
  const total = segments.reduce((sum, segment) => sum + Math.max(segment.value, 0), 0);

  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-full bg-base-300"
      role="img"
      aria-label={ariaLabel}
    >
      {segments.map((segment) => {
        const ratio = ratioOf(segment.value, total);
        if (ratio <= 0) return null;
        return (
          <div
            key={segment.key}
            className={`h-full ${segment.colorClass} motion-safe:transition-all motion-safe:duration-500`}
            style={{ width: `${ratio * 100}%` }}
            title={segment.label}
          />
        );
      })}
    </div>
  );
}
