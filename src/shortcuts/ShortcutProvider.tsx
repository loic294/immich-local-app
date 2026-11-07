import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSettings } from "../hooks/useSettings";
import { DEFAULT_BINDINGS, resolveBindings, type ShortcutBindings } from "./catalog";
import { useAppMenuEvents } from "./useAppMenuEvents";
import { useAppMenuSync } from "./useAppMenuSync";
import { useShortcutKeyboard } from "./useShortcutKeyboard";

const ShortcutBindingsContext = createContext<ShortcutBindings>(DEFAULT_BINDINGS);

/** The effective shortcut bindings: the defaults with the user's customizations applied. */
export function useShortcutBindings(): ShortcutBindings {
  return useContext(ShortcutBindingsContext);
}

interface ShortcutProviderProps {
  children: ReactNode;
}

/**
 * Owns everything global about shortcuts: the customized bindings, the single keyboard listener,
 * and the two-way link to the native menu bar. Mounted once, above the whole app.
 */
export function ShortcutProvider({ children }: ShortcutProviderProps) {
  const settings = useSettings();
  const overrides = settings.data?.keyboardShortcuts;
  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);

  useShortcutKeyboard(bindings);
  useAppMenuEvents();
  useAppMenuSync(bindings);

  return (
    <ShortcutBindingsContext.Provider value={bindings}>{children}</ShortcutBindingsContext.Provider>
  );
}
