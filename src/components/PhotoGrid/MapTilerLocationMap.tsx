import { useMemo } from "react";
import { MapPin } from "lucide-react";
import Map, { Marker } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapTilerLocationMapProps {
  latitude: number;
  longitude: number;
  apiKey: string;
}

export function MapTilerLocationMap({
  latitude,
  longitude,
  apiKey,
}: MapTilerLocationMapProps) {
  const mapStyle = useMemo(
    () =>
      `https://api.maptiler.com/maps/dataviz-v4-dark/style.json?key=${encodeURIComponent(apiKey)}`,
    [apiKey],
  );

  return (
    <div className="h-90 w-full overflow-hidden rounded-lg border border-white/10">
      <Map
        initialViewState={{
          latitude,
          longitude,
          zoom: 13,
        }}
        style={{ width: "100%", height: "100%" }}
        mapStyle={mapStyle}
      >
        <Marker latitude={latitude} longitude={longitude} anchor="bottom">
          <MapPin
            className="h-7 w-7 text-primary drop-shadow-sm"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </Marker>
      </Map>
    </div>
  );
}
