import { Plus, RotateCcw, X } from "lucide-react";
import type { ShortcutSettingsState } from "../../hooks/useShortcutSettings";
import { useShortcutLabels } from "../../i18n/shortcuts";
import { isDefaultBinding, type ShortcutActionId } from "../../shortcuts/catalog";
import { formatCombo } from "../../shortcuts/combo";
import { IS_MAC } from "../../shortcuts/shortcutRegistry";

interface ShortcutRowProps {
  actionId: ShortcutActionId;
  state: ShortcutSettingsState;
}

/** One action with its shortcuts, an add button that records a key combination, and a reset. */
export function ShortcutRow({ actionId, state }: ShortcutRowProps) {
  const labels = useShortcutLabels();
  const actionLabel = labels.actions[actionId];
  const combos = state.bindings[actionId];
  const recording = state.recordingFor === actionId;
  const replacement =
    state.pendingReplacement?.actionId === actionId ? state.pendingReplacement : null;

  return (
    <li className="border-b border-base-300 px-4 py-3 last:border-b-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 text-sm font-medium">{actionLabel}</span>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {combos.length === 0 && !recording && (
            <span className="text-sm text-base-content/50">{labels.settings.unassigned}</span>
          )}
          {combos.map((combo) => {
            const shortcut = formatCombo(combo, IS_MAC);
            return (
              <span
                key={combo}
                className="inline-flex items-center gap-1 rounded-field bg-base-200 py-0.5 pl-2 pr-0.5"
              >
                <kbd className="kbd kbd-sm">{shortcut}</kbd>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-circle"
                  disabled={state.saving}
                  aria-label={labels.settings.removeShortcut(shortcut, actionLabel)}
                  onClick={() => state.remove(actionId, combo)}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
          <button
            type="button"
            className={`btn btn-xs ${recording ? "btn-primary" : "btn-outline"}`}
            aria-pressed={recording}
            aria-label={labels.settings.addShortcutFor(actionLabel)}
            disabled={state.saving}
            onClick={() => (recording ? state.cancelRecording() : state.startRecording(actionId))}
          >
            {recording ? (
              labels.settings.recording
            ) : (
              <>
                <Plus size={12} />
                {labels.settings.addShortcut}
              </>
            )}
          </button>
          {!isDefaultBinding(state.bindings, actionId) && (
            <button
              type="button"
              className="btn btn-ghost btn-xs btn-square"
              disabled={state.saving}
              aria-label={labels.settings.resetAction(actionLabel)}
              title={labels.settings.resetAction(actionLabel)}
              onClick={() => state.reset(actionId)}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </div>
      {recording && (
        <p role="status" className="mt-2 text-xs text-base-content/60">
          {labels.settings.recordingHint}
        </p>
      )}
      {recording && state.message && (
        <p role="alert" className="mt-2 text-sm text-warning">
          {state.message}
        </p>
      )}
      {replacement && (
        <div role="alert" className="alert alert-warning alert-soft mt-2 flex-wrap text-sm">
          <span className="min-w-0 break-words">
            {labels.settings.conflict(
              formatCombo(replacement.combo, IS_MAC),
              replacement.conflicts.map((conflictId) => labels.actions[conflictId]).join(", "),
            )}
          </span>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm" onClick={state.cancelRecording}>
              {labels.settings.cancel}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-warning"
              disabled={state.saving}
              onClick={state.confirmReplacement}
            >
              {labels.settings.replace}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
