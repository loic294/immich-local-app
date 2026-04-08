import { useEffect, useMemo, useState } from "react";
import type { AssetCacheDetails, AssetSummary } from "../../types";

interface FullscreenInfoPanelProps {
  asset: AssetSummary;
  details: AssetCacheDetails | null;
  isLoading: boolean;
  isUpdatingDescription: boolean;
  onUpdateDescription: (description: string) => void;
}

export function FullscreenInfoPanel({
  asset,
  details,
  isLoading,
  isUpdatingDescription,
  onUpdateDescription,
}: FullscreenInfoPanelProps) {
  const exif = useMemo(() => {
    if (!details?.exifInfoJson) {
      return null;
    }

    try {
      return JSON.parse(details.exifInfoJson) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [details?.exifInfoJson]);

  const [descriptionDraft, setDescriptionDraft] = useState(
    details?.description ?? "",
  );

  useEffect(() => {
    setDescriptionDraft(details?.description ?? "");
  }, [details?.description, details?.id]);

  const focalLength = getExifString(exif, [
    "focalLength",
    "focalLenIn35mmFilm",
  ]);
  const shutterSpeed = getExifString(exif, ["exposureTime", "shutterSpeed"]);
  const aperture = getExifString(exif, ["fNumber", "apertureValue"]);
  const iso = getExifString(exif, ["iso", "isoSpeedRatings"]);
  const city = getExifString(exif, ["city"]);
  const state = getExifString(exif, ["state", "stateProvince"]);
  const country = getExifString(exif, ["country"]);
  const latitude = getExifNumber(exif, ["latitude"]);
  const longitude = getExifNumber(exif, ["longitude"]);

  const fileName = details?.originalFileName ?? asset.originalFileName;
  const dimensionsText =
    details?.width && details?.height
      ? `${details.width} x ${details.height}`
      : asset.width && asset.height
        ? `${asset.width} x ${asset.height}`
        : null;
  const fileSizeText =
    details?.fileSizeBytes && details.fileSizeBytes > 0
      ? formatBytes(details.fileSizeBytes)
      : null;
  const headerLine = [dimensionsText, fileSizeText]
    .filter(Boolean)
    .join("  •  ");
  const formatBadge = details?.fileExtension?.toUpperCase() ?? null;
  const locationValue = details?.originalPath ?? "";
  const mapSrc =
    latitude !== null && longitude !== null
      ? buildOpenStreetMapEmbedUrl(latitude, longitude)
      : null;

  return (
    <aside className="pointer-events-auto h-full w-[min(22rem,28vw)] min-w-72 shrink-0 overflow-y-auto bg-zinc-950 p-3 text-xs text-white/80">
      <div className="rounded-xl border border-white/10 bg-zinc-900 p-3">
        <p className="text-sm font-medium text-white">
          {details?.camera ?? "Unknown camera"}
        </p>
        {details?.lens ? (
          <p className="mt-0.5 text-xs text-white/65">{details.lens}</p>
        ) : null}
        <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-white/65">
          <span>{headerLine || "Unknown dimensions"}</span>
          {formatBadge ? (
            <span className="rounded-md bg-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white">
              {formatBadge}
            </span>
          ) : null}
        </div>

        <div className="my-3 h-px bg-white/10" />

        {isLoading ? (
          <div className="mb-3 flex items-center gap-2 text-[11px] text-white/60">
            <span className="loading loading-spinner loading-xs" />
            Loading cached metadata...
          </div>
        ) : null}

        <div className="space-y-1.5">
          <InlineInfoRow label="FOCAL LENGTH" value={focalLength} />
          <InlineInfoRow label="SHUTTER SPEED" value={shutterSpeed} />
          <InlineInfoRow label="APERTURE" value={formatAperture(aperture)} />
          <InlineInfoRow label="ISO" value={iso} />
        </div>
      </div>

      <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-zinc-900 p-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-white/45">
            Description
          </p>
          <textarea
            className="textarea textarea-sm mt-1 min-h-24 w-full rounded-lg border-white/10 bg-zinc-950 text-[11px] leading-snug text-white/85"
            value={descriptionDraft}
            placeholder="Add a description"
            onChange={(event) => setDescriptionDraft(event.currentTarget.value)}
            onBlur={() => onUpdateDescription(descriptionDraft)}
            disabled={isUpdatingDescription}
          />
          {isUpdatingDescription ? (
            <p className="mt-1 text-[10px] text-white/45">
              Saving description...
            </p>
          ) : null}
        </div>

        <InfoRow label="File Name" value={fileName} />
        <InfoRow
          label="Captured"
          value={formatCapturedAt(
            details?.fileCreatedAt ?? asset.fileCreatedAt,
          )}
        />
        <InfoInputRow label="Location" value={locationValue} />
        <InfoRow label="City" value={city} />
        <InfoRow label="State / Province" value={state} />
        <InfoRow label="Country" value={country} />
        <InfoRow
          label="GPS"
          value={
            latitude !== null && longitude !== null
              ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
              : null
          }
        />

        {mapSrc ? (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-white/45">
              Map
            </p>
            <div className="mt-1 overflow-hidden rounded-lg border border-white/10">
              <iframe
                title="Photo location map"
                src={mapSrc}
                className="h-32 w-full bg-zinc-950"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          </div>
        ) : null}
      </div>

      {details?.people || details?.tags ? (
        <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-zinc-900 p-3">
          <InfoRow label="People" value={details.people} />
          <InfoRow label="Tags" value={details.tags} />
        </div>
      ) : null}
    </aside>
  );
}

function InlineInfoRow({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="uppercase tracking-wide text-white/45">{label}</span>
      <span className="text-right text-white/85">{value ?? "-"}</span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-white/45">
        {label}
      </p>
      <p className="mt-0.5 text-xs leading-snug text-white/85">
        {value ?? "-"}
      </p>
    </div>
  );
}

function InfoInputRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-white/45">
        {label}
      </p>
      <input
        type="text"
        readOnly
        value={value}
        className="input input-sm mt-1 h-8 w-full rounded-lg border-white/10 bg-zinc-950 text-[11px] text-white/85"
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}

function getExifString(
  exif: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!exif) {
    return null;
  }

  for (const key of keys) {
    const value = exif[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function getExifNumber(
  exif: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!exif) {
    return null;
  }

  for (const key of keys) {
    const value = exif[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function formatAperture(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.startsWith("f/") ? value : `f/${value}`;
}

function formatCapturedAt(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const precision = index === 0 ? 0 : index === 1 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function buildOpenStreetMapEmbedUrl(
  latitude: number,
  longitude: number,
): string {
  const delta = 0.01;
  const left = longitude - delta;
  const right = longitude + delta;
  const top = latitude + delta;
  const bottom = latitude - delta;

  const params = new URLSearchParams({
    bbox: `${left},${bottom},${right},${top}`,
    layer: "mapnik",
    marker: `${latitude},${longitude}`,
  });

  return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
}
