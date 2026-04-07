import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { AssetSummary } from "../../types";
import { getAssetThumbnail } from "../../api/tauri";

type PhotoGridProps = {
  assets: AssetSummary[];
  isFetching: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
};

export function PhotoGrid({
  assets,
  isFetching,
  hasNextPage,
  onLoadMore,
}: PhotoGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [activeSrc, setActiveSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!sentinelRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasNextPage && !isFetching) {
          onLoadMore();
        }
      },
      {
        root: viewportRef.current,
        rootMargin: "600px 0px",
      },
    );

    observer.observe(sentinelRef.current);

    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetching, onLoadMore]);

  const loadedCountText = useMemo(() => {
    if (!hasNextPage) {
      return `${assets.length} loaded (all)`;
    }
    return `${assets.length} loaded`;
  }, [assets.length, hasNextPage]);

  const sections = useMemo(() => {
    return groupAssetsByDay(assets);
  }, [assets]);

  const hasActive =
    activeIndex !== null && activeIndex >= 0 && activeIndex < assets.length;

  useEffect(() => {
    if (!hasActive || activeIndex === null) {
      return;
    }

    let cancelled = false;
    const asset = assets[activeIndex];

    async function loadActiveImage() {
      try {
        const value = await getAssetThumbnail(asset.id);
        if (!cancelled) {
          setActiveSrc(value);
        }
      } catch {
        if (!cancelled) {
          setActiveSrc(null);
        }
      }
    }

    void loadActiveImage();

    return () => {
      cancelled = true;
    };
  }, [activeIndex, assets, hasActive]);

  useEffect(() => {
    if (!hasActive) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveIndex(null);
        setActiveSrc(null);
        return;
      }

      if (event.key === "ArrowLeft") {
        setActiveIndex((current) => {
          if (current === null) {
            return current;
          }
          return Math.max(0, current - 1);
        });
        return;
      }

      if (event.key === "ArrowRight") {
        setActiveIndex((current) => {
          if (current === null) {
            return current;
          }
          return Math.min(assets.length - 1, current + 1);
        });
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [assets.length, hasActive]);

  const activeAsset =
    hasActive && activeIndex !== null ? assets[activeIndex] : null;

  const openLightbox = (assetId: string, src: string) => {
    const index = assets.findIndex((asset) => asset.id === assetId);
    if (index < 0) {
      return;
    }

    setActiveIndex(index);
    setActiveSrc(src);
  };

  const closeLightbox = () => {
    setActiveIndex(null);
    setActiveSrc(null);
  };

  const goPrev = () => {
    setActiveIndex((current) => {
      if (current === null) {
        return current;
      }
      return Math.max(0, current - 1);
    });
  };

  const goNext = () => {
    setActiveIndex((current) => {
      if (current === null) {
        return current;
      }
      return Math.min(assets.length - 1, current + 1);
    });
  };

  return (
    <section className="grid-shell">
      <div className="grid-stats">{loadedCountText}</div>

      <div ref={viewportRef} className="grid-viewport">
        <div className="justified-grid">
          {sections.map((section) => (
            <section key={section.key} className="day-section">
              <div className="day-separator">
                <span>{section.label}</span>
              </div>

              <div className="day-grid">
                {section.items.map((asset) => (
                  <article key={asset.id} className="asset-card day-item">
                    <AssetThumbnail
                      assetId={asset.id}
                      name={asset.originalFileName}
                      onOpen={(src) => {
                        openLightbox(asset.id, src);
                      }}
                    />
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div ref={sentinelRef} className="load-sentinel" />
      </div>

      {isFetching ? <p className="status">Loading more assets...</p> : null}
      {!hasNextPage ? <p className="status">No more assets to load.</p> : null}

      {activeAsset ? (
        <div
          className="lightbox-overlay"
          role="dialog"
          aria-modal="true"
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="lightbox-close"
            aria-label="Close full screen"
            onClick={(event) => {
              event.stopPropagation();
              closeLightbox();
            }}
          >
            <X size={22} />
          </button>

          <button
            type="button"
            className="lightbox-nav lightbox-prev"
            aria-label="Previous image"
            onClick={(event) => {
              event.stopPropagation();
              goPrev();
            }}
            disabled={activeIndex === 0}
          >
            <ChevronLeft size={28} />
          </button>

          <button
            type="button"
            className="lightbox-nav lightbox-next"
            aria-label="Next image"
            onClick={(event) => {
              event.stopPropagation();
              goNext();
            }}
            disabled={activeIndex === assets.length - 1}
          >
            <ChevronRight size={28} />
          </button>

          <img
            className="lightbox-image"
            src={activeSrc ?? ""}
            alt={activeAsset.originalFileName}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </section>
  );
}
function groupAssetsByDay(
  assets: AssetSummary[],
): Array<{ key: string; label: string; items: AssetSummary[] }> {
  const sections: Array<{ key: string; label: string; items: AssetSummary[] }> =
    [];
  let currentKey = "";
  let currentLabel = "";
  let currentItems: AssetSummary[] = [];

  for (const asset of assets) {
    const { key, label } = getAssetDay(asset.fileCreatedAt);

    if (currentKey === "") {
      currentKey = key;
      currentLabel = label;
    }

    if (key !== currentKey) {
      sections.push({
        key: currentKey,
        label: currentLabel,
        items: currentItems,
      });
      currentKey = key;
      currentLabel = label;
      currentItems = [];
    }

    currentItems.push(asset);
  }

  if (currentItems.length > 0) {
    sections.push({
      key: currentKey,
      label: currentLabel,
      items: currentItems,
    });
  }

  return sections;
}

function getAssetDay(fileCreatedAt: string | null): {
  key: string;
  label: string;
} {
  if (!fileCreatedAt) {
    return { key: "unknown", label: "Unknown date" };
  }

  const date = new Date(fileCreatedAt);
  if (Number.isNaN(date.getTime())) {
    return { key: "unknown", label: "Unknown date" };
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const key = `${y}-${m}-${d}`;
  const label = date.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return { key, label };
}

function AssetThumbnail({
  assetId,
  name,
  onOpen,
}: {
  assetId: string;
  name: string;
  onOpen: (src: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const value = await getAssetThumbnail(assetId);
        if (!canceled) {
          setSrc(value);
        }
      } catch {
        if (!canceled) {
          setSrc(null);
        }
      }
    }

    void load();

    return () => {
      canceled = true;
    };
  }, [assetId]);

  if (!src) {
    return <div className="thumb thumb-placeholder">Loading preview...</div>;
  }

  return (
    <button
      type="button"
      className="thumb-button"
      onClick={() => onOpen(src)}
      aria-label={`Open ${name} in full screen`}
    >
      <img className="thumb" src={src} alt={name} loading="lazy" />
    </button>
  );
}
