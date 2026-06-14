import { createContext, useContext, type ReactNode } from "react";

type ConnectionContextValue = {
  /** Null until the first probe completes. */
  isOnline: boolean | null;
  /** Mutations queued locally while offline, awaiting replay. */
  pendingCount: number;
};

const ConnectionContext = createContext<ConnectionContextValue>({
  isOnline: null,
  pendingCount: 0,
});

export function ConnectionProvider({
  value,
  children,
}: {
  value: ConnectionContextValue;
  children: ReactNode;
}) {
  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

/** Read the app-wide local-first connection state. */
export function useConnectionContext(): ConnectionContextValue {
  return useContext(ConnectionContext);
}
