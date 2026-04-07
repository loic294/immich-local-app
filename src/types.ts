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
