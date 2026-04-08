import { useRef, useState } from "react";
import { ZoomIn } from "lucide-react";

interface ZoomControlProps {
  zoomLevel: number;
  onZoomChange: (zoom: number) => void;
}

export function ZoomControl({ zoomLevel, onZoomChange }: ZoomControlProps) {
  const [showSlider, setShowSlider] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);

  const handleMouseEnter = () => {
    if (hideTimeoutRef.current !== null) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setShowSlider(true);
  };

  const handleMouseLeave = () => {
    hideTimeoutRef.current = window.setTimeout(() => {
      setShowSlider(false);
      hideTimeoutRef.current = null;
    }, 100);
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="btn btn-sm btn-ghost border border-white/15 bg-zinc-900 text-white flex items-center gap-1"
        aria-label="Zoom"
        onClick={() => onZoomChange(100)}
      >
        <ZoomIn size={16} />
        <span className="text-xs font-medium">{zoomLevel}%</span>
      </button>

      {showSlider && (
        <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-zinc-800 border border-white/15 rounded-lg p-1 shadow-lg z-50 whitespace-nowrap">
          <input
            type="range"
            min="5"
            max="800"
            value={zoomLevel}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            className="range range-sm w-50 m-0 p-0"
          />
        </div>
      )}
    </div>
  );
}
