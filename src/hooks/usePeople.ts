import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCachedPeople, refreshPeople } from "../api/browsing";
import { useConnectionContext } from "./connectionContext";

export function usePeople() {
  const queryClient = useQueryClient();
  const { isOnline } = useConnectionContext();
  const refreshed = useRef(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["browsing-people"], queryFn: getCachedPeople });
  useEffect(() => {
    if (isOnline !== true || refreshed.current) return;
    refreshed.current = true;
    console.log("[browsing.people] background refresh start");
    void refreshPeople()
      .then(() => {
        console.log("[browsing.people] background refresh complete");
        return queryClient.invalidateQueries({ queryKey: ["browsing-people"] });
      })
      .catch((error: unknown) => {
        const message = String(error);
        console.warn("[browsing.people] refresh failed; cached people preserved", error);
        if (!message.startsWith("offline:")) setRefreshError(message);
      });
  }, [isOnline, queryClient]);
  return { ...query, refreshError };
}
