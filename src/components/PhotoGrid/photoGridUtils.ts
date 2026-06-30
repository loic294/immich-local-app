import { convertFileSrc } from "@tauri-apps/api/core";
import { thumbHashToRGBA } from "thumbhash";
import type { AssetSummary } from "../../types";
import type { VirtualEntry } from "./PhotoGrid.types";

export function findFirstEntryAtOrAfter(entries: VirtualEntry[], top: number): number {
  let left = 0;
  let right = entries.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (entries[mid].top < top) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return left;
}

export function isVideoAsset(asset: AssetSummary): boolean {
  if ((asset.type ?? "").toUpperCase() === "VIDEO") {
    return true;
  }

  const name = asset.originalFileName.toLowerCase();
  return /(\.mp4|\.mov|\.webm|\.mkv|\.avi|\.m4v)$/.test(name);
}

export function formatVideoDuration(value: string | null, durationSeconds?: number): string {
  if (
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    return formatDurationSeconds(Math.round(durationSeconds));
  }

  if (!value) {
    return "0:00";
  }

  const trimmed = value.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number.parseFloat(trimmed);
    return formatDurationSeconds(Math.max(0, Math.round(numeric)));
  }

  if (/^PT/i.test(trimmed)) {
    const isoMatch = trimmed.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i);
    if (isoMatch) {
      const hours = Number.parseFloat(isoMatch[1] ?? "0");
      const minutes = Number.parseFloat(isoMatch[2] ?? "0");
      const seconds = Number.parseFloat(isoMatch[3] ?? "0");
      const totalSeconds = Math.round(hours * 3600 + minutes * 60 + seconds);
      if (Number.isFinite(totalSeconds) && totalSeconds > 0) {
        return formatDurationSeconds(totalSeconds);
      }
    }
  }

  const main = trimmed.split(".")[0] ?? "";
  const parts = main
    .split(":")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

  if (parts.length === 0) {
    return "0:00";
  }

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }

  return formatDurationSeconds(seconds);
}

export function formatDurationSeconds(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function toPlayableSrc(value: string): string {
  if (value.startsWith("/")) {
    return convertFileSrc(value);
  }

  return value;
}

export function preloadImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to preload image"));
    image.src = src;
  });
}

export function getAssetAspectRatio(asset: AssetSummary | null): number {
  if (!asset) {
    return 4 / 3;
  }

  if (asset.width && asset.height && asset.height > 0) {
    return asset.width / asset.height;
  }

  return 4 / 3;
}

const thumbhashDataUrlCache = new Map<string, string>();

export function thumbhashToDataUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const cached = thumbhashDataUrlCache.get(value);
  if (cached) {
    return cached;
  }

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const decoded = thumbHashToRGBA(bytes);
    const canvas = document.createElement("canvas");
    canvas.width = decoded.w;
    canvas.height = decoded.h;

    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    const imageData = context.createImageData(decoded.w, decoded.h);
    imageData.data.set(decoded.rgba);
    context.putImageData(imageData, 0, 0);

    const dataUrl = canvas.toDataURL("image/png");
    thumbhashDataUrlCache.set(value, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

export function parseDayKey(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return { year, month, day };
}
