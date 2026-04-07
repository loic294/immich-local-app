export type AssetSummary = {
  id: string;
  originalFileName: string;
  fileCreatedAt: string | null;
  checksum: string | null;
};

export type AssetPage = {
  page: number;
  pageSize: number;
  items: AssetSummary[];
  hasNextPage: boolean;
};

export type MemorySummary = {
  id: string;
  title: string | null;
  memoryAt: string | null;
  year: number | null;
  assets: AssetSummary[];
};

export type TimelineMonths = {
  newestMonth: string | null;
  oldestMonth: string | null;
  months: string[];
};
