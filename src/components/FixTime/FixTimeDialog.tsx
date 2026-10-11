import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useSearchTimeI18n } from "../../i18n/searchTime";
import {
  useApplyTimeShift,
  useReferenceAssets,
  useSelectedAssetTimes,
} from "../../hooks/useFixTime";
import type { FixTimeAsset, FixTimeReferenceSource } from "../../types/time";
import { differenceSeconds, formatAssetDateTime, shiftIso } from "../../utils/timeOffset";
import { FixTimeAssetPanel } from "./FixTimeAssetPanel";
import { FixTimeOffsetEditor } from "./FixTimeOffsetEditor";

type FixTimeDialogProps = {
  assetIds: string[];
  source: FixTimeReferenceSource;
  onClose: () => void;
};

export function FixTimeDialog({ assetIds, source, onClose }: FixTimeDialogProps) {
  const t = useSearchTimeI18n();
  const { locale } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selected = useSelectedAssetTimes(assetIds);
  const reference = useReferenceAssets(source, true);
  const apply = useApplyTimeShift();
  const [left, setLeft] = useState<FixTimeAsset | null>(null);
  const [right, setRight] = useState<FixTimeAsset | null>(null);
  const [offsetSeconds, setOffsetSeconds] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (!left && selected.data?.length) setLeft(selected.data[0]);
  }, [left, selected.data]);

  const computedOffset = useMemo(
    () => (left && right ? differenceSeconds(left.fileCreatedAt, right.fileCreatedAt) : null),
    [left, right],
  );
  useEffect(() => {
    if (computedOffset !== null) setOffsetSeconds(computedOffset);
  }, [computedOffset]);

  const referenceAssets = useMemo(
    () => reference.assets.filter((asset) => !assetIds.includes(asset.id)),
    [assetIds, reference.assets],
  );

  const result = apply.data;
  const busy = apply.isPending;
  const failedMessage = result?.failed[0]?.error ?? "";

  const submit = () => {
    if (offsetSeconds === 0 || busy) return;
    apply.mutate({ assetIds, offsetSeconds });
  };

  const done = !!result && result.failed.length === 0;
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(onClose, 1200);
    return () => window.clearTimeout(timer);
  }, [done, onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="modal z-[1000]"
      data-test="fix-time-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="modal-box flex h-[85vh] w-11/12 max-w-6xl flex-col gap-3">
        <header>
          <h2 className="text-lg font-bold">{t("fixTimeTitle")}</h2>
          <p className="text-sm opacity-70">{t("fixTimeSubtitle", { count: assetIds.length })}</p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <FixTimeAssetPanel
            title={t("selectedPanel", { count: assetIds.length })}
            hint={t("pickLeft")}
            assets={selected.data ?? []}
            selectedId={left?.id ?? null}
            tone="primary"
            onSelect={setLeft}
            footer={selected.isLoading ? <p className="p-2 text-sm">{t("loading")}</p> : null}
          />
          <FixTimeAssetPanel
            title={t("referencePanel")}
            hint={t("pickRight")}
            assets={referenceAssets}
            selectedId={right?.id ?? null}
            tone="secondary"
            onSelect={(asset) => setRight((current) => (current?.id === asset.id ? null : asset))}
            onEndReached={reference.loadMore}
            footer={
              reference.isLoading || reference.isFetchingNextPage ? (
                <p className="p-2 text-sm">{t("loading")}</p>
              ) : reference.isError ? (
                <p role="alert" className="p-2 text-sm text-error">
                  {String(reference.error)}
                </p>
              ) : referenceAssets.length === 0 ? (
                <p className="p-2 text-sm opacity-70">{t("emptyReference")}</p>
              ) : null
            }
          />
        </div>

        <div className="grid gap-2 text-sm md:grid-cols-2">
          <div className="rounded-box border border-primary/40 bg-base-200 p-2">
            <span className="badge badge-primary badge-sm mr-2">1</span>
            <strong>{left?.originalFileName ?? t("pickLeft")}</strong>
            <div>{formatAssetDateTime(left?.fileCreatedAt ?? null, locale)}</div>
          </div>
          <div className="rounded-box border border-secondary/40 bg-base-200 p-2">
            <span className="badge badge-secondary badge-sm mr-2">2</span>
            <strong>{right?.originalFileName ?? t("pickRight")}</strong>
            <div>{formatAssetDateTime(right?.fileCreatedAt ?? null, locale)}</div>
          </div>
        </div>

        <FixTimeOffsetEditor
          offsetSeconds={offsetSeconds}
          computed={computedOffset !== null}
          onChange={setOffsetSeconds}
        />

        {left && offsetSeconds !== 0 && (
          <p className="text-sm">
            {t("preview", {
              name: left.originalFileName,
              from: formatAssetDateTime(left.fileCreatedAt, locale),
              to: formatAssetDateTime(shiftIso(left.fileCreatedAt, offsetSeconds), locale),
            })}
          </p>
        )}
        <p className="text-xs opacity-60">{t("metadataOnly")}</p>

        {result && (
          <div
            role="status"
            className={`alert alert-soft ${result.failed.length ? "alert-warning" : "alert-success"}`}
          >
            <div className="flex flex-col">
              {result.updatedCount > 0 && (
                <span>{t("resultUpdated", { count: result.updatedCount })}</span>
              )}
              {result.queuedCount > 0 && (
                <span>{t("resultQueued", { count: result.queuedCount })}</span>
              )}
              {result.failed.length > 0 && (
                <span>
                  {t("resultFailed", { count: result.failed.length, error: failedMessage })}
                </span>
              )}
            </div>
          </div>
        )}
        {apply.isError && (
          <div role="alert" className="alert alert-error alert-soft">
            {String(apply.error)}
          </div>
        )}

        <div className="modal-action mt-0">
          <button
            type="button"
            className="btn btn-ghost"
            data-test="fix-time-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-test="fix-time-apply"
            disabled={busy || offsetSeconds === 0}
            title={offsetSeconds === 0 ? t("zeroOffset") : undefined}
            onClick={submit}
          >
            {busy ? <span className="loading loading-spinner loading-sm" /> : null}
            {busy ? t("applying") : t("apply")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
