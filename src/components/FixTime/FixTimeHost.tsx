import { useMemo } from "react";
import { useFixTimeRequest } from "../../hooks/useFixTime";
import type { AssetFilterCriteria, ViewScope } from "../../types";
import { FixTimeDialog } from "./FixTimeDialog";

type FixTimeHostProps = {
  viewScope?: ViewScope;
  criteria?: AssetFilterCriteria | null;
};

const ALL_SCOPE: ViewScope = { kind: "all" };

/** Mounts the Fix time dialog when an `immich:fix-time` event is received. */
export function FixTimeHost({ viewScope, criteria }: FixTimeHostProps) {
  const { assetIds, close } = useFixTimeRequest();
  const source = useMemo(
    () => ({ scope: viewScope ?? ALL_SCOPE, criteria: criteria ?? null }),
    [criteria, viewScope],
  );
  if (!assetIds) return null;
  return (
    <FixTimeDialog key={assetIds.join(",")} assetIds={assetIds} source={source} onClose={close} />
  );
}
