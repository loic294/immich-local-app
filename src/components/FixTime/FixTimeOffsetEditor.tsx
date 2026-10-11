import { useSearchTimeI18n } from "../../i18n/searchTime";
import type { TimeOffsetParts } from "../../types/time";
import { joinOffset, splitOffset } from "../../utils/timeOffset";

type FixTimeOffsetEditorProps = {
  offsetSeconds: number;
  computed: boolean;
  onChange: (offsetSeconds: number) => void;
};

const FIELDS = ["days", "hours", "minutes", "seconds"] as const;
const MAX: Record<(typeof FIELDS)[number], number> = {
  days: 73000,
  hours: 23,
  minutes: 59,
  seconds: 59,
};

export function FixTimeOffsetEditor({
  offsetSeconds,
  computed,
  onChange,
}: FixTimeOffsetEditorProps) {
  const t = useSearchTimeI18n();
  const parts = splitOffset(offsetSeconds);
  const update = (patch: Partial<TimeOffsetParts>) => onChange(joinOffset({ ...parts, ...patch }));

  return (
    <fieldset className="fieldset rounded-box border border-base-300 p-3">
      <legend className="fieldset-legend">{t("difference")}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <div className="join">
          <button
            type="button"
            className={`btn btn-sm join-item ${parts.sign === 1 ? "btn-primary" : ""}`}
            onClick={() => update({ sign: 1 })}
          >
            {t("later")}
          </button>
          <button
            type="button"
            className={`btn btn-sm join-item ${parts.sign === -1 ? "btn-primary" : ""}`}
            onClick={() => update({ sign: -1 })}
          >
            {t("earlier")}
          </button>
        </div>
        {FIELDS.map((field) => (
          <label key={field} className="flex flex-col gap-1 text-xs">
            <span>{t(field)}</span>
            <input
              type="number"
              min={0}
              max={MAX[field]}
              className="input input-sm w-20"
              value={parts[field]}
              onChange={(event) => update({ [field]: Number(event.target.value) || 0 })}
            />
          </label>
        ))}
      </div>
      <p className="label">{computed ? t("differenceComputed") : t("differenceManual")}</p>
    </fieldset>
  );
}
