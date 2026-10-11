import { useEffect, useRef, type ReactNode } from "react";
import type { FixTimeAsset } from "../../types/time";
import { FixTimeAssetTile } from "./FixTimeAssetTile";

type FixTimeAssetPanelProps = {
  title: string;
  hint: string;
  assets: FixTimeAsset[];
  selectedId: string | null;
  tone: "primary" | "secondary";
  onSelect: (asset: FixTimeAsset) => void;
  /** Called when the bottom sentinel becomes visible (infinite scroll). */
  onEndReached?: () => void;
  footer?: ReactNode;
};

export function FixTimeAssetPanel({
  title,
  hint,
  assets,
  selectedId,
  tone,
  onSelect,
  onEndReached,
  footer,
}: FixTimeAssetPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onEndRef = useRef(onEndReached);
  onEndRef.current = onEndReached;

  const infinite = onEndReached !== undefined;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !infinite) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onEndRef.current?.();
      },
      { root: scrollRef.current, rootMargin: "300px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [infinite]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <header>
        <h3 className="font-semibold">{title}</h3>
        <p className="text-xs opacity-70">{hint}</p>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-box bg-base-100 p-2">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {assets.map((asset) => (
            <FixTimeAssetTile
              key={asset.id}
              asset={asset}
              tone={tone}
              selected={asset.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
        {footer}
        <div ref={sentinelRef} className="h-1" />
      </div>
    </section>
  );
}
