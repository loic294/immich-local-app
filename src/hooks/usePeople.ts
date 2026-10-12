import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCachedPeople, getCachedNamedPeople, refreshPeople } from "../api/browsing";
import { useConnectionContext } from "./connectionContext";
import type { Session } from "./useSession";

export function usePeople(session: Session) {
  const queryClient = useQueryClient();
  const { isOnline } = useConnectionContext();
  const scope = JSON.stringify([session.serverUrl, session.userId]);
  const refreshed = useRef<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["browsing-people", scope], queryFn: getCachedPeople });
  useEffect(() => {
    if (isOnline !== true || refreshed.current === scope) return;
    refreshed.current = scope;
    setRefreshError(null);
    console.log("[browsing.people] background refresh start");
    void refreshPeople()
      .then(() => {
        console.log("[browsing.people] background refresh complete");
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: ["browsing-people", scope] }),
          queryClient.invalidateQueries({ queryKey: ["browsing-named-people"] }),
        ]);
      })
      .catch((error: unknown) => {
        const message = String(error);
        console.warn("[browsing.people] refresh failed; cached people preserved", error);
        if (!message.startsWith("offline:")) setRefreshError(message);
      });
  }, [isOnline, queryClient, scope]);
  return { ...query, refreshError };
}

export function useNamedPeople(accountId: string) {
  return useQuery({
    queryKey: ["browsing-named-people", accountId],
    queryFn: () => getCachedNamedPeople(accountId),
  });
}
