import { useSearchTimeI18n, type SearchTimeKey } from "../../i18n/searchTime";
import { useMetadataSearchForm, useMetadataSuggestions } from "../../hooks/useMetadataSearchForm";
import type { ViewScope } from "../../types";
import type { MetadataMediaFilter, MetadataSearchType } from "../../types/search";

type MetadataSearchPanelProps = {
  query: string;
  scope?: ViewScope;
  onSubmit: (query: string) => void;
  onClose: () => void;
};

const SEARCH_TYPES: Array<[MetadataSearchType, SearchTimeKey]> = [
  ["context", "context"],
  ["filename", "fileName"],
  ["description", "description"],
  ["path", "path"],
];

const MEDIA: Array<[MetadataMediaFilter, SearchTimeKey]> = [
  ["", "mediaAll"],
  ["photo", "mediaPhoto"],
  ["video", "mediaVideo"],
  ["raw", "mediaRaw"],
  ["favorite", "mediaFavorite"],
];

/** Immich-style "Filter by" popover that builds a structured metadata query. */
export function MetadataSearchPanel({ query, scope, onSubmit, onClose }: MetadataSearchPanelProps) {
  const t = useSearchTimeI18n();
  const { form, update, clear, query: built } = useMetadataSearchForm(query);
  const suggestions = useMetadataSuggestions(true, scope);

  const textInput = (
    key: "person" | "place" | "camera" | "lens" | "tag",
    label: SearchTimeKey,
    list?: string,
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase opacity-70">{t(label)}</span>
      <input
        className="input input-sm w-full"
        list={list}
        value={form[key]}
        onChange={(event) => update(key, event.target.value)}
      />
    </label>
  );

  return (
    <form
      className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(built);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <h3 className="text-sm font-bold uppercase">{t("filterBy")}</h3>

      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t("searchType")}</legend>
        <div className="flex flex-wrap gap-3">
          {SEARCH_TYPES.map(([type, label]) => (
            <label key={type} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="metadata-search-type"
                className="radio radio-sm radio-primary"
                checked={form.searchType === type}
                onChange={() => update("searchType", type)}
              />
              {t(label)}
            </label>
          ))}
        </div>
        <input
          className="input input-sm mt-2 w-full"
          placeholder={t("textPlaceholder")}
          value={form.text}
          onChange={(event) => update("text", event.target.value)}
          autoFocus
        />
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        {textInput("person", "people", "metadata-search-people")}
        {textInput("place", "places")}
        {textInput("camera", "camera", "metadata-search-cameras")}
        {textInput("lens", "lens")}
        {textInput("tag", "tags")}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase opacity-70">{t("media")}</span>
          <select
            className="select select-sm w-full"
            value={form.media}
            onChange={(event) => update("media", event.target.value as MetadataMediaFilter)}
          >
            {MEDIA.map(([value, label]) => (
              <option key={value || "all"} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <datalist id="metadata-search-people">
        {suggestions.people.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="metadata-search-cameras">
        {suggestions.cameras.map((camera) => (
          <option key={camera} value={camera} />
        ))}
      </datalist>

      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t("date")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            <span>{t("after")}</span>
            <input
              type="date"
              className="input input-sm w-full"
              value={form.after}
              onChange={(event) => update("after", event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span>{t("before")}</span>
            <input
              type="date"
              className="input input-sm w-full"
              value={form.before}
              onChange={(event) => update("before", event.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t("advanced")}</legend>
        <input
          className="input input-sm w-full font-mono"
          value={form.extra}
          onChange={(event) => update("extra", event.target.value)}
        />
        <p className="label">{t("advancedHelp")}</p>
      </fieldset>

      <code className="block truncate rounded-box bg-base-200 px-2 py-1 text-xs" title={built}>
        {built || "—"}
      </code>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            clear();
            onSubmit("");
          }}
        >
          {t("clearAll")}
        </button>
        <button type="submit" className="btn btn-sm btn-primary">
          {t("search")}
        </button>
      </div>
    </form>
  );
}
