import { useMemo } from "react";
import type { AssetSummary, AssetCacheDetails } from "../../types";

interface FullscreenInfoPanelProps {
  asset: AssetSummary;
  details: AssetCacheDetails | null;
  isLoading: boolean;
}

export function FullscreenInfoPanel({
  asset,
  details,
  isLoading,
}: FullscreenInfoPanelProps) {
  const exif = useMemo(() => {
    if (!details?.exifInfoJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(details.exifInfoJson) as Record<string, unknown>;
      return parsed;
    } catch {
      return null;
    }
  }, [details?.exifInfoJson]);

  const focalLength = getExifString(exif, ["focalLength", "focalLenIn35mmFilm"]);
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
  const headerLine = [dimensionsText, fileSizeText].filter(Boolean).join("  •  ");
  const formatBadge = details?.fileExtension?.toUpperCase() ?? null;

  return (
    <aside className="pointer-events-auto h-full w-[min(30rem,36vw)] min-w-88 shrink-0 overflow-y-auto border-l border-white/15 bg-zinc-950 p-4 text-sm text-white/85">
      <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900 p-4">
        <p className="text-lg font-medium text-white">
          {details?.camera ?? "Unknown camera"}
        </p>
        {details?.lens ? <p className="text-white/75">{details.lens}</p> : null}
        <div className="flex items-center justify-between gap-3 text-white/70">
          <span>{headerLine || "Unknown dimensions"}</span>
          {formatBadge ? (
            <span className="rounded-md bg-zinc-700 px-2 py-0.5 text-xs uppercase tracking-wide text-white">
              {formatBadge}
            </span>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-white/70">
          <span className="loading loading-spinner loading-xs" />
          Loading cached metadata...
        </div>
      ) : null}

      <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-zinc-900 p-4">
        <InfoRow label="Focal length" value={focalLength} />
        <InfoRow label="Shutter speed" value={shutterSpeed} />
        <InfoRow label="Aperture" value={formatAperture(aperture)} />
        <InfoRow label="ISO" value={iso} />
      </div>

      <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-zinc-900 p-4">
        <InfoRow label="File Name" value={fileName} />
        <InfoRow
          label="Captured"
          value={formatCapturedAt(details?.fileCreatedAt ?? asset.fileCreatedAt)}
        />
        <InfoRow label="Location" value={details?.originalPath ?? null} />
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
      </div>

      {details?.people || details?.tags ? (
        <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-zinc-900 p-4">
          <InfoRow label="People" value={details.people} />
          <InfoRow label="Tags" value={details.tags} />
        </div>
      ) : null}
    </aside>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-white/55">{label}</p>
      <p className="mt-0.5 text-base leading-snug text-white/90">{value ?? "-"}</p>
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
