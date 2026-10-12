import { useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { trackFeature } from "../../api/media";
import { useSearchTimeI18n } from "../../i18n/searchTime";
import type { ViewScope } from "../../types";
import { countMetadataFilters } from "../../utils/metadataQuery";
import { MetadataSearchPanel } from "./MetadataSearchPanel";

type MetadataSearchBarProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Show the Immich-style "Filter by" metadata popover. */
  enableFilters?: boolean;
  scope?: ViewScope;
};

/** Search input with an optional structured metadata filter popover. */
export function MetadataSearchBar({
  value,
  onChange,
  placeholder,
  enableFilters = true,
  scope,
}: MetadataSearchBarProps) {
  const t = useSearchTimeI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const filterCount = enableFilters ? countMetadataFilters(value) : 0;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const submit = (query: string) => {
    console.info(`[search] submit length=${query.length} filters=${countMetadataFilters(query)}`);
    onChange(query);
    if (enableFilters && query.trim()) trackFeature("search");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative w-64 shrink-0 sm:w-80 lg:w-md">
      <label
        className="input input-bordered flex w-full items-center gap-2 rounded-full"
        htmlFor="asset-search"
      >
        <Search size={16} className="text-base-content/60" />
        <input
          id="asset-search"
          placeholder={placeholder ?? (enableFilters ? t("searchPlaceholder") : undefined)}
          type="text"
          className="grow"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(value);
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {value && (
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            aria-label={t("clearAll")}
            onClick={() => onChange("")}
          >
            <X size={14} />
          </button>
        )}
        {enableFilters && (
          <button
            type="button"
            className={`btn btn-ghost btn-xs gap-1 ${open || filterCount ? "text-primary" : ""}`}
            aria-label={t("openFilters")}
            aria-expanded={open}
            title={filterCount ? t("activeFilters", { count: filterCount }) : t("openFilters")}
            onClick={() => setOpen((current) => !current)}
          >
            <SlidersHorizontal size={14} />
            {filterCount > 0 && <span className="badge badge-primary badge-xs">{filterCount}</span>}
          </button>
        )}
      </label>
      {open && enableFilters && (
        <div className="absolute left-0 top-full z-[120] mt-2 w-[min(36rem,90vw)] rounded-box border border-base-300 bg-base-100 shadow-xl">
          <MetadataSearchPanel
            query={value}
            scope={scope}
            onSubmit={submit}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
