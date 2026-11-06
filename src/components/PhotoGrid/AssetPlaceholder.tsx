import { Check } from "lucide-react";
import { thumbhashToDataUrl } from "./photoGridUtils";

interface AssetPlaceholderProps {
  width: number;
  thumbhash: string | null;
  /** True when this photo is selected even though its page has not loaded yet (e.g. via a day checkbox). */
  isSelected: boolean;
}

/**
 * Stand-in for a photo whose page has not loaded yet in full layout mode. It keeps
 * the virtual canvas stable, shows a blurred thumbhash preview, and mirrors the
 * selected look of a loaded thumbnail.
 */
export function AssetPlaceholder({ width, thumbhash, isSelected }: AssetPlaceholderProps) {
  const placeholderSrc = thumbhashToDataUrl(thumbhash);

  return (
    <div
      className={`relative h-full shrink-0 overflow-hidden bg-base-300 ${
        isSelected ? "rounded-sm border-4 border-primary" : ""
      }`}
      style={{ width: `${width}px` }}
    >
      {isSelected ? (
        <div
          aria-hidden="true"
          className="absolute left-1 top-1 z-20 flex h-5 w-5 items-center justify-center rounded border border-primary bg-primary text-primary-content"
        >
          <Check size={12} />
        </div>
      ) : null}
      {placeholderSrc ? (
        <img
          className="h-full w-full object-cover scale-110 blur-xl opacity-85"
          src={placeholderSrc}
          alt=""
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
