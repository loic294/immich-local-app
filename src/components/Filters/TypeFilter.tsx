import type { MediaTypeFilter } from "../../types";

interface TypeFilterProps {
  /** The selected media type, or null for all types. */
  value: MediaTypeFilter | null;
  onChange: (value: MediaTypeFilter | null) => void;
}

const OPTIONS: { value: MediaTypeFilter; label: string }[] = [
  { value: "photo", label: "Photo" },
  { value: "raw", label: "RAW" },
  { value: "photo_raw", label: "Photo + RAW" },
  { value: "video", label: "Video" },
];

/**
 * daisyUI select for the media type. The empty option clears the type filter
 * (returns to "all types").
 */
export function TypeFilter({ value, onChange }: TypeFilterProps) {
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <select
        className="select select-sm z-10 w-40"
        value={value ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" ? null : (next as MediaTypeFilter));
        }}
        aria-label="Filter by media type"
      >
        <option value="">All types</option>
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
