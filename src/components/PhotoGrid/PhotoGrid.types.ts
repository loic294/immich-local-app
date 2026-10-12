import type {
  AssetFilterCriteria,
  AssetSummary,
  GridLayoutResponse,
  TimelineLayoutResponse,
  ViewScope,
} from "../../types";

export type SelectionCommand = {
  type: "clear" | "select-all";
  nonce: number;
} | null;

export type PhotoGridProps = {
  assets: AssetSummary[];
  hideArchivedAssets?: boolean;
  isFetching: boolean;
  isFetchingPrevious?: boolean;
  hasNextPage: boolean;
  hasPreviousPage?: boolean;
  onLoadMore: () => Promise<void> | void;
  onLoadPrevious?: () => Promise<void> | void;
  onJumpToDate?: (dateKey: string) => Promise<void> | void;
  loadFullLayout?: (containerWidth: number) => Promise<GridLayoutResponse>;
  loadTimelineLayout?: (containerWidth: number) => Promise<TimelineLayoutResponse>;
  maxHeight?: number;
  onSelectedCountChange?: (count: number) => void;
  onSelectedIdsChange?: (ids: string[]) => void;
  selectionCommand?: SelectionCommand;
  /** Current view, used as the reference source of the Fix time dialog. */
  viewScope?: ViewScope;
  /** Current view criteria (filters + metadata query) for the Fix time reference panel. */
  viewCriteria?: AssetFilterCriteria | null;
};

export type VirtualEntry =
  | {
      type: "header";
      key: string;
      sectionKey: string;
      label: string;
      top: number;
      height: number;
    }
  | {
      type: "row";
      key: string;
      sectionKey: string;
      top: number;
      height: number;
      items: { id: string; width: number; thumbhash: string | null }[];
    };

export type ScrollRestoreAnchor = {
  direction: "prepend" | "append";
  assetId: string;
  offsetWithinRow: number;
  capturedScrollTop: number;
  capturedAt: number;
};

export type JumpMetrics = {
  jumpId: string;
  dateKey: string;
  startedAtMs: number;
};
