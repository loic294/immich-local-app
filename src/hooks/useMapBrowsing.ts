import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCachedMapAssets, getCachedMapMarkers, refreshMapAssets } from "../api/browsing";
import { useConnectionContext } from "./connectionContext";
import type { MapBounds } from "../types/browsing";

const world: MapBounds = { west: -180, south: -90, east: 180, north: 90 };

export function useMapBrowsing(initialAssetId?: string) {
  const client = useQueryClient();
  const { isOnline } = useConnectionContext();
  const [bounds, setBounds] = useState(world);
  const [isViewReady, setIsViewReady] = useState(false);
  const updateBounds = useCallback((value: MapBounds) => {
    setBounds(value);
    setIsViewReady(true);
  }, []);
  const [assetIds, setAssetIds] = useState<string[] | null>(
    initialAssetId ? [initialAssetId] : null,
  );
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshed = useRef(new Set<string>());
  const inFlight = useRef(false);
  const markers = useQuery({ queryKey: ["map-markers"], queryFn: getCachedMapMarkers });
  const assets = useQuery({
    queryKey: ["map-assets", bounds, assetIds, refreshNonce],
    queryFn: () => getCachedMapAssets(bounds, assetIds),
    enabled: isViewReady,
    placeholderData: (previous) => previous,
  });
  const refresh = useCallback(async () => {
    if (inFlight.current || isOnline !== true || !assets.data?.length) return;
    const ids = assets.data
      .filter((asset) => !refreshed.current.has(asset.id))
      .slice(0, 100)
      .map((asset) => asset.id);
    if (!ids.length) return;
    ids.forEach((id) => refreshed.current.add(id));
    inFlight.current = true;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      console.log("[browsing.map] bounded refresh", { count: ids.length });
      await refreshMapAssets(ids);
    } catch (error) {
      ids.forEach((id) => refreshed.current.delete(id));
      console.warn("[browsing.map] bounded refresh failed", error);
      setRefreshError(String(error));
    } finally {
      await client.invalidateQueries({ queryKey: ["map-markers"] });
      setRefreshNonce((value) => value + 1);
      inFlight.current = false;
      setIsRefreshing(false);
    }
  }, [assets.data, client, isOnline]);
  // Refresh once on opening the view, never recursively sweep the whole library.
  const initialRefresh = useRef(false);
  useEffect(() => {
    if (isOnline !== true || initialRefresh.current || !assets.data?.length) return;
    initialRefresh.current = true;
    void refresh();
  }, [assets.data, isOnline, refresh]);
  return {
    bounds,
    setBounds: updateBounds,
    isViewReady,
    assetIds,
    setAssetIds,
    markers,
    assets,
    refreshNonce,
    refresh,
    refreshError,
    isRefreshing,
  };
}
