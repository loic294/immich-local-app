import { useEffect, useMemo, useRef, useState } from "react";

type TimelineMonth = {
  monthKey: string;
  jumpDateKey: string;
  year: number;
  month: number;
  rowCount: number;
};

interface VerticalTimelineProps {
  months: TimelineMonth[];
  scrollRatio: number;
  onSeekRatio: (ratio: number) => void;
  onJumpToDateKey: (dateKey: string) => void;
  onScrubStateChange?: (isScrubbing: boolean) => void;
}

type TimelinePoint = {
  monthKey: string;
  jumpDateKey: string;
  year: number;
  month: number;
  rowCount: number;
  positionPercent: number;
};

export function VerticalTimeline({
  months,
  scrollRatio,
  onSeekRatio,
  onJumpToDateKey,
  onScrubStateChange,
}: VerticalTimelineProps) {
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const pendingRatioRef = useRef<number | null>(null);
  const dragRatioRef = useRef<number | null>(null);
  const seekDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    onScrubStateChange?.(isDragging);

    return () => {
      onScrubStateChange?.(false);
    };
  }, [isDragging, onScrubStateChange]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.height <= 0) {
        return;
      }

      const ratio = clamp01((event.clientY - rect.top) / rect.height);
      pendingRatioRef.current = ratio;

      if (dragRafRef.current !== null) {
        return;
      }

      dragRafRef.current = window.requestAnimationFrame(() => {
        dragRafRef.current = null;
        if (pendingRatioRef.current !== null) {
          dragRatioRef.current = pendingRatioRef.current;
          setDragRatio(pendingRatioRef.current);

          if (seekDebounceRef.current !== null) {
            window.clearTimeout(seekDebounceRef.current);
          }

          seekDebounceRef.current = window.setTimeout(() => {
            seekDebounceRef.current = null;
            if (dragRatioRef.current !== null) {
              onSeekRatio(dragRatioRef.current);
            }
          }, 120);

          pendingRatioRef.current = null;
        }
      });
    };

    const handleMouseUp = () => {
      if (dragRafRef.current !== null) {
        window.cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (seekDebounceRef.current !== null) {
        window.clearTimeout(seekDebounceRef.current);
        seekDebounceRef.current = null;
      }
      const settled = pendingRatioRef.current ?? dragRatioRef.current;
      pendingRatioRef.current = null;
      dragRatioRef.current = null;
      setDragRatio(null);
      setIsDragging(false);
      if (settled !== null) {
        onSeekRatio(settled);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (dragRafRef.current !== null) {
        window.cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (seekDebounceRef.current !== null) {
        window.clearTimeout(seekDebounceRef.current);
        seekDebounceRef.current = null;
      }
    };
  }, [isDragging, onSeekRatio]);

  const { points, yearMarkers } = useMemo(() => {
    if (months.length === 0) {
      return {
        points: [] as TimelinePoint[],
        yearMarkers: [] as TimelinePoint[],
      };
    }

    const totalWeight = months.reduce(
      (sum, month) => sum + Math.max(1, month.rowCount),
      0,
    );
    let cumulative = 0;

    const computedPoints = months.map((month) => {
      const weight = Math.max(1, month.rowCount);
      const center = cumulative + weight / 2;
      cumulative += weight;

      return {
        monthKey: month.monthKey,
        jumpDateKey: month.jumpDateKey,
        year: month.year,
        month: month.month,
        rowCount: month.rowCount,
        positionPercent: totalWeight > 0 ? (center / totalWeight) * 100 : 0,
      };
    });

    const seenYears = new Set<number>();
    const computedYearMarkers: TimelinePoint[] = [];

    for (const point of computedPoints) {
      if (!seenYears.has(point.year)) {
        seenYears.add(point.year);
        computedYearMarkers.push(point);
      }
    }

    return {
      points: computedPoints,
      yearMarkers: computedYearMarkers,
    };
  }, [months]);

  if (points.length === 0) {
    return null;
  }

  const activeRatio =
    isDragging && dragRatio !== null ? dragRatio : clamp01(scrollRatio);
  const labelRatio = isDragging ? activeRatio : hoverRatio;
  const labelMonth =
    labelRatio === null ? null : getMonthForRatio(points, clamp01(labelRatio));
  const hoverLabel = labelMonth
    ? `${MONTH_NAMES[labelMonth.month - 1]} ${labelMonth.year}`
    : null;

  return (
    <aside className="hidden h-[calc(100vh-180px)] w-16 shrink-0 lg:block">
      <div
        ref={containerRef}
        className="relative mt-13 h-[calc(100%-52px)] w-full select-none"
      >
        <button
          type="button"
          className="absolute inset-y-1 left-0 w-6 rounded-full bg-base-300/70 hover:bg-base-300"
          onMouseEnter={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.height <= 0) {
              return;
            }

            setHoverRatio(clamp01((event.clientY - rect.top) / rect.height));
          }}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.height <= 0) {
              return;
            }

            setHoverRatio(clamp01((event.clientY - rect.top) / rect.height));
          }}
          onMouseLeave={() => {
            setHoverRatio(null);
          }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.height <= 0) {
              return;
            }

            const ratio = clamp01((event.clientY - rect.top) / rect.height);
            onSeekRatio(ratio);
          }}
          aria-label="Scroll timeline"
        />

        {labelRatio !== null && hoverLabel ? (
          <div
            className="pointer-events-none absolute left-2 -translate-y-2/3 whitespace-nowrap rounded-full border border-base-100/90 bg-base-content px-2 py-1 text-[10px] font-semibold text-base-100 shadow-lg"
            style={{ top: `${labelRatio * 100}%` }}
          >
            {hoverLabel}
          </div>
        ) : null}

        {points.map((point) => (
          <button
            key={point.monthKey}
            type="button"
            className="absolute left-2 h-1.5 w-1.5 rounded-full bg-base-content/70 hover:scale-125 hover:bg-primary z-50"
            style={{ top: `calc(${point.positionPercent}% - 2px)` }}
            onClick={() => {
              onJumpToDateKey(point.jumpDateKey);
            }}
            aria-label={`Jump to ${point.monthKey}`}
          />
        ))}

        {yearMarkers.map((marker) => (
          <button
            key={`year-${marker.year}`}
            type="button"
            className="absolute right-1 -translate-y-1/2 p-0 text-[10px] font-semibold tabular-nums text-base-content/70 hover:text-primary"
            style={{ top: `${marker.positionPercent}%` }}
            onClick={() => {
              onJumpToDateKey(marker.jumpDateKey);
            }}
            aria-label={`Jump to ${marker.year}`}
          >
            {marker.year}
          </button>
        ))}

        <div
          role="slider"
          aria-valuenow={Math.round(activeRatio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Scroll position"
          tabIndex={0}
          className={`absolute left-1 h-4 w-4 cursor-row-resize rounded-full border-2 border-primary bg-primary/40 shadow transition-transform hover:scale-125 active:scale-125 ${isDragging ? "cursor-grabbing scale-125" : ""}`}
          style={{ top: `calc(${activeRatio * 100}% - 8px)` }}
          onMouseDown={(event) => {
            event.preventDefault();
            dragRatioRef.current = activeRatio;
            setDragRatio(activeRatio);
            setIsDragging(true);
          }}
        />
      </div>
    </aside>
  );
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function getMonthForRatio(
  points: TimelinePoint[],
  ratio: number,
): TimelinePoint | null {
  if (points.length === 0) {
    return null;
  }

  if (points.length === 1) {
    return points[0];
  }

  const clamped = clamp01(ratio);

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    const next = points[index + 1];

    const start = previous
      ? (previous.positionPercent + current.positionPercent) / 200
      : 0;
    const end = next
      ? (current.positionPercent + next.positionPercent) / 200
      : 1;

    if (clamped >= start && clamped <= end) {
      return current;
    }
  }

  return points[points.length - 1];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
