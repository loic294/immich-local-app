import { Star, Equal, ChevronUp, ChevronDown } from "lucide-react";
import type { RatingMode } from "../../types";
import { useI18n } from "../../i18n";

interface RatingFilterProps {
  /** The selected rating threshold (1-5), or null when inactive. */
  rating: number | null;
  /** How the rating is compared against each asset. */
  mode: RatingMode;
  onChange: (rating: number | null, mode: RatingMode) => void;
}

const RATING_MODES: RatingMode[] = ["gte", "eq", "lte"];

function ModeIcon({ mode }: { mode: RatingMode }) {
  if (mode === "gte") return "≥";
  if (mode === "lte") return "≤";
  return "=";
}

/**
 * Star rating filter: five star buttons plus a mode toggle that cycles between
 * "equal", "above and equal" and "lower and equal". Clicking the active star
 * again clears the rating filter.
 */
export function RatingFilter({ rating, mode, onChange }: RatingFilterProps) {
  const { t } = useI18n();
  const modeLabels: Record<RatingMode, string> = {
    gte: t("filters.ratingGte"),
    eq: t("filters.ratingEq"),
    lte: t("filters.ratingLte"),
  };

  const handleStarClick = (value: number) => {
    if (rating === value) {
      onChange(null, mode);
      return;
    }
    onChange(value, mode);
  };

  const cycleMode = () => {
    const currentIndex = RATING_MODES.indexOf(mode);
    const nextMode = RATING_MODES[(currentIndex + 1) % RATING_MODES.length];
    onChange(rating, nextMode);
  };

  return (
    <div className="flex shrink-0 flex-col justify-center">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn btn-xs btn-ghost btn-square"
          onClick={cycleMode}
          aria-label={modeLabels[mode]}
          title={modeLabels[mode]}
        >
          <ModeIcon mode={mode} />
        </button>
        <div className="flex items-center">
          {[1, 2, 3, 4, 5].map((value) => {
            const filled = rating != null && value <= rating;
            return (
              <button
                key={value}
                type="button"
                className="btn btn-xs btn-ghost btn-square"
                onClick={() => handleStarClick(value)}
                aria-label={t("filters.starsAria", {
                  count: value,
                  suffix: value > 1 ? "s" : "",
                })}
                aria-pressed={filled}
              >
                <Star
                  size={16}
                  className={
                    filled
                      ? "fill-warning text-warning"
                      : "text-base-content/40"
                  }
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
