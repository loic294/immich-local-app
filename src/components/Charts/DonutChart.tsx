import { donutArcs } from "../../utils/albumStatistics";

export interface DonutChartSegment {
  key: string;
  value: number;
  label: string;
  /** Text color utility (e.g. `text-primary`); segments stroke with currentColor. */
  colorClass: string;
}

interface DonutChartProps {
  segments: DonutChartSegment[];
  ariaLabel: string;
  centerValue: string;
  centerCaption: string;
}

const RADIUS = 40;
const STROKE_WIDTH = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function DonutChart({ segments, ariaLabel, centerValue, centerCaption }: DonutChartProps) {
  const arcs = donutArcs(
    segments.map((segment) => segment.value),
    CIRCUMFERENCE,
  );

  return (
    <figure className="relative mx-auto aspect-square w-40 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full" role="img" aria-label={ariaLabel}>
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          className="stroke-base-300"
        />
        <g transform="rotate(-90 50 50)">
          {segments.map((segment, index) => {
            const arc = arcs[index];
            if (arc.length <= 0) return null;
            return (
              <circle
                key={segment.key}
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth={STROKE_WIDTH}
                strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
                strokeDashoffset={arc.offset}
                className={`${segment.colorClass} motion-safe:transition-all motion-safe:duration-500`}
              >
                <title>{segment.label}</title>
              </circle>
            );
          })}
        </g>
      </svg>
      <figcaption
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
      >
        <span className="text-2xl font-bold tabular-nums">{centerValue}</span>
        <span className="text-xs text-base-content/60">{centerCaption}</span>
      </figcaption>
    </figure>
  );
}
