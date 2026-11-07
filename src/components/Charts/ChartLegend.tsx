export interface ChartLegendItem {
  key: string;
  label: string;
  value: string;
  detail?: string;
  /** Background color utility for the swatch (e.g. `bg-primary`). */
  swatchClass: string;
}

interface ChartLegendProps {
  items: ChartLegendItem[];
}

export function ChartLegend({ items }: ChartLegendProps) {
  return (
    <ul className="flex w-full flex-col gap-2 text-sm">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-3 w-3 shrink-0 rounded-full ${item.swatchClass}`}
          />
          <span className="min-w-0 flex-1 truncate" title={item.label}>
            {item.label}
          </span>
          <span className="font-medium tabular-nums">{item.value}</span>
          {item.detail !== undefined && (
            <span className="w-14 text-right text-base-content/60 tabular-nums">{item.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
