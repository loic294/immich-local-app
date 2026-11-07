import type { Account } from "../api/tauri";
import type { AccountAlbumStatistics, AlbumStatistics } from "../types/albumStatistics";

export interface ChartColor {
  text: string;
  bg: string;
}

/** Literal class names so Tailwind keeps them in the build. */
export const ALBUM_COVERAGE_COLORS = {
  inAlbums: { text: "text-primary", bg: "bg-primary" },
  notInAlbums: { text: "text-secondary", bg: "bg-secondary" },
} satisfies Record<string, ChartColor>;

export const ACCOUNT_CHART_COLORS: ChartColor[] = [
  { text: "text-info", bg: "bg-info" },
  { text: "text-success", bg: "bg-success" },
  { text: "text-warning", bg: "bg-warning" },
  { text: "text-accent", bg: "bg-accent" },
  { text: "text-neutral", bg: "bg-neutral" },
  { text: "text-error", bg: "bg-error" },
];

export interface DonutArc {
  length: number;
  offset: number;
}

export interface AccountStatisticsRow extends AccountAlbumStatistics {
  label: string;
  serverUrl: string | null;
  totalAssets: number;
  color: ChartColor;
}

export function totalAssets(stats: Pick<AlbumStatistics, "assetsInAlbums" | "assetsNotInAlbums">) {
  return stats.assetsInAlbums + stats.assetsNotInAlbums;
}

/** Ratio in [0, 1]; 0 when there is nothing to compare against. */
export function ratioOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) return 0;
  return Math.min(part / total, 1);
}

/** Stroke dash lengths/offsets for consecutive donut segments on a circle. */
export function donutArcs(values: number[], circumference: number): DonutArc[] {
  const safe = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  let consumed = 0;
  return safe.map((value) => {
    const length = total > 0 ? (value / total) * circumference : 0;
    const arc = { length, offset: -consumed };
    consumed += length;
    return arc;
  });
}

function accountLabel(account: Account): string {
  return account.userName || account.userEmail || account.userId;
}

function emptyAccountStats(accountId: string): AccountAlbumStatistics {
  return {
    accountId,
    albumCount: 0,
    sharedAlbumCount: 0,
    unsyncedAlbumCount: 0,
    assetsInAlbums: 0,
    assetsNotInAlbums: 0,
  };
}

/**
 * Signed-in accounts first (in their app order, even with no cached data),
 * then any cached data owned by accounts that are no longer signed in.
 */
export function buildAccountRows(
  stats: AlbumStatistics,
  accounts: Account[],
  unknownAccountLabel: string,
): AccountStatisticsRow[] {
  const byId = new Map(stats.accounts.map((entry) => [entry.accountId, entry]));
  const known = accounts.map((account) => ({
    ...(byId.get(account.id) ?? emptyAccountStats(account.id)),
    label: accountLabel(account),
    serverUrl: account.serverUrl,
  }));
  const signedIn = new Set(accounts.map((account) => account.id));
  const orphaned = stats.accounts
    .filter((entry) => !signedIn.has(entry.accountId))
    .map((entry) => ({ ...entry, label: unknownAccountLabel, serverUrl: null }));
  return [...known, ...orphaned].map((row, index) => ({
    ...row,
    totalAssets: totalAssets(row),
    color: ACCOUNT_CHART_COLORS[index % ACCOUNT_CHART_COLORS.length],
  }));
}

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    ratio,
  );
}
