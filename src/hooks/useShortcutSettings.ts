import { useMemo, useState } from "react";
import { updateSettings } from "../api/tauri";
import { useShortcutLabels } from "../i18n/shortcuts";
import {
  DEFAULT_BINDINGS,
  diffOverrides,
  findConflicts,
  getComboRejection,
  resetBinding,
  resolveBindings,
  withBinding,
  withoutBinding,
  withoutConflicts,
  type ComboRejection,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../shortcuts/catalog";
import { formatCombo } from "../shortcuts/combo";
import { IS_MAC } from "../shortcuts/shortcutRegistry";
import type { Settings } from "../types";
import { useShortcutRecorder } from "./useShortcutRecorder";

export interface PendingReplacement {
  actionId: ShortcutActionId;
  combo: string;
  conflicts: ShortcutActionId[];
}

export interface ShortcutSettingsState {
  bindings: ShortcutBindings;
  recordingFor: ShortcutActionId | null;
  pendingReplacement: PendingReplacement | null;
  saving: boolean;
  /** A rejected key or a failed save, shown next to the shortcut list. */
  message: string | null;
  startRecording: (actionId: ShortcutActionId) => void;
  cancelRecording: () => void;
  remove: (actionId: ShortcutActionId, combo: string) => void;
  reset: (actionId: ShortcutActionId) => void;
  resetAll: () => void;
  confirmReplacement: () => void;
}

/**
 * Edits the keyboard shortcut bindings stored in the app settings. Only customized actions are
 * saved, so actions left at their defaults keep following future default changes.
 */
export function useShortcutSettings(
  settings: Settings,
  onSaved: (settings: Settings) => void,
): ShortcutSettingsState {
  const labels = useShortcutLabels();
  const bindings = useMemo(
    () => resolveBindings(settings.keyboardShortcuts),
    [settings.keyboardShortcuts],
  );
  const [recordingFor, setRecordingFor] = useState<ShortcutActionId | null>(null);
  const [pendingReplacement, setPendingReplacement] = useState<PendingReplacement | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const commit = async (next: ShortcutBindings) => {
    const overrides = diffOverrides(next);
    setSaving(true);
    setMessage(null);
    setPendingReplacement(null);
    console.info("[shortcuts.settings] saving shortcuts", {
      customizedActions: Object.keys(overrides).length,
    });
    try {
      onSaved(await updateSettings({ ...settings, keyboardShortcuts: overrides }));
    } catch (error) {
      console.error("[shortcuts.settings] saving shortcuts failed", error);
      setMessage(labels.settings.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const describeRejection = (rejection: ComboRejection, combo: string): string => {
    const shortcut = formatCombo(combo, IS_MAC);
    if (rejection === "reserved") {
      return labels.settings.rejectedReserved(shortcut);
    }
    if (rejection === "textEditing") {
      return labels.settings.rejectedTextEditing(shortcut);
    }
    return labels.settings.rejectedInvalid;
  };

  const cancelRecording = () => {
    setRecordingFor(null);
    setPendingReplacement(null);
    setMessage(null);
  };

  const handleCombo = (combo: string) => {
    if (!recordingFor) {
      return;
    }
    const rejection = getComboRejection(recordingFor, combo);
    if (rejection) {
      console.info("[shortcuts.settings] rejected combo", { actionId: recordingFor, rejection });
      setMessage(describeRejection(rejection, combo));
      return;
    }
    setRecordingFor(null);
    setMessage(null);
    if (bindings[recordingFor].includes(combo)) {
      return;
    }
    const conflicts = findConflicts(bindings, recordingFor, combo);
    if (conflicts.length > 0) {
      setPendingReplacement({ actionId: recordingFor, combo, conflicts });
      return;
    }
    void commit(withBinding(bindings, recordingFor, combo));
  };

  useShortcutRecorder({
    active: recordingFor !== null,
    onCombo: handleCombo,
    onCancel: cancelRecording,
  });

  return {
    bindings,
    recordingFor,
    pendingReplacement,
    saving,
    message,
    startRecording: (actionId) => {
      setPendingReplacement(null);
      setMessage(null);
      setRecordingFor(actionId);
    },
    cancelRecording,
    remove: (actionId, combo) => void commit(withoutBinding(bindings, actionId, combo)),
    reset: (actionId) => void commit(resetBinding(bindings, actionId)),
    resetAll: () => void commit(DEFAULT_BINDINGS),
    confirmReplacement: () => {
      if (!pendingReplacement) {
        return;
      }
      const { actionId, combo } = pendingReplacement;
      void commit(withBinding(withoutConflicts(bindings, actionId, combo), actionId, combo));
    },
  };
}
