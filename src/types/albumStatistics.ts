export interface AccountAlbumStatistics {
  accountId: string;
  albumCount: number;
  sharedAlbumCount: number;
  unsyncedAlbumCount: number;
  assetsInAlbums: number;
  assetsNotInAlbums: number;
}

export interface AlbumStatistics {
  albumCount: number;
  sharedAlbumCount: number;
  /** Non-empty albums whose photo memberships are not cached yet. */
  unsyncedAlbumCount: number;
  assetsInAlbums: number;
  assetsNotInAlbums: number;
  accounts: AccountAlbumStatistics[];
}
