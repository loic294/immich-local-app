import { RotateCcw } from "lucide-react";
import { useShortcutSettings } from "../../hooks/useShortcutSettings";
import { useShortcutLabels } from "../../i18n/shortcuts";
import { diffOverrides, SHORTCUT_ACTIONS, SHORTCUT_GROUP_ORDER } from "../../shortcuts/catalog";
import type { Settings } from "../../types";
import { ShortcutRow } from "./ShortcutRow";

interface ShortcutSettingsProps {
  settings: Settings;
  onSaved: (settings: Settings) => void;
}

/** Lists every shortcut by group and lets the user record, remove and reset key bindings. */
export function ShortcutSettings({ settings, onSaved }: ShortcutSettingsProps) {
  const labels = useShortcutLabels();
  const state = useShortcutSettings(settings, onSaved);
  const hasCustomizations = Object.keys(diffOverrides(state.bindings)).length > 0;

  return (
    <div className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="card-title">{labels.settings.title}</h2>
            <p className="text-sm text-base-content/70">{labels.settings.description}</p>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={state.saving || !hasCustomizations}
            onClick={state.resetAll}
          >
            <RotateCcw size={14} />
            {labels.settings.resetAll}
          </button>
        </div>
        {state.message && state.recordingFor === null && (
          <div role="alert" className="alert alert-error alert-soft text-sm">
            {state.message}
          </div>
        )}
        {SHORTCUT_GROUP_ORDER.map((group) => (
          <section key={group} aria-labelledby={`shortcut-group-${group}`}>
            <h3
              id={`shortcut-group-${group}`}
              className="mb-2 text-sm font-semibold text-base-content/70"
            >
              {labels.groups[group]}
            </h3>
            <ul className="rounded-box border border-base-300">
              {SHORTCUT_ACTIONS.filter((action) => action.group === group).map((action) => (
                <ShortcutRow key={action.id} actionId={action.id} state={state} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
