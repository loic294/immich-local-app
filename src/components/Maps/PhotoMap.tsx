import { useEffect, useMemo, useRef, useState } from "react";
import Map, {
  Layer,
  Marker,
  NavigationControl,
  Source,
  type MapRef,
  type MapLayerMouseEvent,
} from "react-map-gl/maplibre";
import type { GeoJSONSource, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapBounds, MapFocus, MapMarker } from "../../types/browsing";
import { useConnectionContext } from "../../hooks/connectionContext";
import { useBrowsingI18n } from "../../i18n/browsing";
import { MapPhotoMarker } from "./MapPhotoMarker";

interface PhotoMapProps {
  markers: MapMarker[];
  focus: MapFocus | null;
  onBoundsChange: (bounds: MapBounds) => void;
  onSelect: (assetIds: string[] | null) => void;
}

const offlineStyle: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#1f2937" } }],
};

type PhotoPin = {
  key: string;
  assetId: string;
  clusterId: number | null;
  count: number;
  latitude: number;
  longitude: number;
};
const rasterStyle: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export function PhotoMap({ markers, focus, onBoundsChange, onSelect }: PhotoMapProps) {
  const t = useBrowsingI18n();
  const { isOnline } = useConnectionContext();
  const map = useRef<MapRef>(null);
  const [mapError, setMapError] = useState(false);
  const [ready, setReady] = useState(false);
  const [pins, setPins] = useState<PhotoPin[]>([]);
  const pinsSignature = useRef("");
  const pinsInFlight = useRef(false);
  const data = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: markers.map((marker) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [marker.longitude, marker.latitude] },
        properties: { assetId: marker.id },
      })),
    }),
    [markers],
  );
  const apiKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim();
  const mapStyle =
    isOnline === false || mapError
      ? offlineStyle
      : apiKey
        ? `https://api.maptiler.com/maps/dataviz-v4-dark/style.json?key=${encodeURIComponent(apiKey)}`
        : rasterStyle;
  const reportBounds = () => {
    const bounds = map.current?.getBounds();
    if (bounds)
      onBoundsChange({
        west:
          bounds.getEast() - bounds.getWest() >= 360
            ? -180
            : ((((bounds.getWest() + 180) % 360) + 360) % 360) - 180,
        south: bounds.getSouth(),
        east:
          bounds.getEast() - bounds.getWest() >= 360
            ? 180
            : ((((bounds.getEast() + 180) % 360) + 360) % 360) - 180,
        north: bounds.getNorth(),
      });
  };
  const updatePins = async () => {
    if (!map.current || pinsInFlight.current || !map.current.isSourceLoaded("photos")) return;
    const source = map.current.getSource("photos") as GeoJSONSource | undefined;
    if (!source) return;
    const features = map.current.querySourceFeatures("photos");
    const unique = new globalThis.Map<string, (typeof features)[number]>();
    const bounds = map.current.getBounds();
    for (const feature of features) {
      if (
        feature.geometry.type !== "Point" ||
        !bounds?.contains(feature.geometry.coordinates as [number, number])
      )
        continue;
      unique.set(
        feature.properties?.cluster
          ? `cluster-${feature.properties.cluster_id}`
          : `asset-${feature.properties?.assetId}`,
        feature,
      );
    }
    const signature = [...unique.keys()].sort().join("|");
    if (signature === pinsSignature.current) return;
    pinsInFlight.current = true;
    try {
      const next = await Promise.all(
        [...unique.entries()].slice(0, 150).map(async ([key, feature]) => {
          const [longitude, latitude] =
            feature.geometry.type === "Point" ? feature.geometry.coordinates : [0, 0];
          const clusterId = feature.properties?.cluster
            ? Number(feature.properties.cluster_id)
            : null;
          const first =
            clusterId !== null ? (await source.getClusterLeaves(clusterId, 1, 0))[0] : feature;
          return {
            key,
            latitude,
            longitude,
            clusterId,
            assetId: String(first.properties?.assetId),
            count: Number(feature.properties?.point_count ?? 1),
          };
        }),
      );
      pinsSignature.current = signature;
      setPins(next);
    } catch (error) {
      console.warn("[browsing.map] photo pins failed", error);
    } finally {
      pinsInFlight.current = false;
    }
  };
  useEffect(() => {
    pinsSignature.current = "";
  }, [markers]);
  const selectPin = async (pin: PhotoPin) => {
    if (pin.clusterId === null) {
      onSelect([pin.assetId]);
      return;
    }
    const source = map.current?.getSource("photos") as GeoJSONSource | undefined;
    if (!source) return;
    try {
      const leaves = await source.getClusterLeaves(pin.clusterId, pin.count, 0);
      onSelect(leaves.map((leaf) => String(leaf.properties?.assetId)));
      const zoom = await source.getClusterExpansionZoom(pin.clusterId);
      map.current?.easeTo({ center: [pin.longitude, pin.latitude], zoom, duration: 500 });
    } catch (error) {
      console.warn("[browsing.map] photo pin selection failed", error);
    }
  };
  useEffect(() => {
    if (!ready || !focus) return;
    map.current?.flyTo({ center: [focus.longitude, focus.latitude], zoom: 14, duration: 500 });
  }, [focus, ready]);
  useEffect(() => {
    setMapError(false);
  }, [isOnline]);
  const handleClick = async (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    if (!feature) {
      onSelect(null);
      return;
    }
    if (feature.properties?.cluster) {
      const source = map.current?.getSource("photos") as GeoJSONSource | undefined;
      if (!source) return;
      try {
        const clusterId = Number(feature.properties.cluster_id);
        const leaves = await source.getClusterLeaves(
          clusterId,
          Number(feature.properties.point_count),
          0,
        );
        onSelect(leaves.map((leaf) => String(leaf.properties?.assetId)));
        const zoom = await source.getClusterExpansionZoom(clusterId);
        if (feature.geometry.type === "Point") {
          map.current?.easeTo({
            center: feature.geometry.coordinates as [number, number],
            zoom,
            duration: 500,
          });
        }
      } catch (error) {
        console.warn("[browsing.map] cluster selection failed", error);
      }
    } else {
      onSelect([String(feature.properties?.assetId)]);
    }
  };
  return (
    <div className="relative h-full min-h-80 overflow-hidden rounded-box">
      <Map
        ref={map}
        initialViewState={
          focus
            ? { latitude: focus.latitude, longitude: focus.longitude, zoom: 14 }
            : {
                latitude: markers[0]?.latitude ?? 20,
                longitude: markers[0]?.longitude ?? 0,
                zoom: markers.length ? 3 : 1,
              }
        }
        mapStyle={mapStyle}
        style={{ width: "100%", height: "100%" }}
        interactiveLayerIds={["clusters", "points"]}
        onClick={(event) => void handleClick(event)}
        onLoad={() => {
          setReady(true);
          reportBounds();
        }}
        onMoveEnd={reportBounds}
        onIdle={() => {
          if (!ready) {
            setReady(true);
            reportBounds();
          }
          void updatePins();
        }}
        onError={(event) => {
          console.warn("[browsing.map] base map unavailable", event.error);
          setMapError(true);
        }}
        cursor="pointer"
      >
        <NavigationControl position="top-right" />
        {pins.map((pin) => (
          <Marker key={pin.key} latitude={pin.latitude} longitude={pin.longitude}>
            <MapPhotoMarker
              assetId={pin.assetId}
              count={pin.count}
              onClick={() => void selectPin(pin)}
            />
          </Marker>
        ))}
        <Source
          id="photos"
          type="geojson"
          data={data}
          cluster
          clusterRadius={45}
          clusterMaxZoom={20}
        >
          <Layer
            id="clusters"
            type="circle"
            filter={["has", "point_count"]}
            paint={{
              "circle-color": "#6366f1",
              "circle-radius": ["step", ["get", "point_count"], 18, 100, 24, 1000, 32],
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 2,
            }}
          />
          <Layer
            id="points"
            type="circle"
            filter={["!", ["has", "point_count"]]}
            paint={{
              "circle-color": "#6366f1",
              "circle-radius": 8,
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 2,
            }}
          />
        </Source>
      </Map>
      {isOnline === false || mapError ? (
        <div role="status" className="alert alert-warning absolute bottom-4 left-4 right-4 text-sm">
          {t(isOnline === false ? "mapOffline" : "mapError")}
        </div>
      ) : null}
    </div>
  );
}
