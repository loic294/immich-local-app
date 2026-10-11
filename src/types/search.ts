/** Search types offered by the metadata search bar (mirrors Immich). */
export type MetadataSearchType = "context" | "filename" | "description" | "path";

export type MetadataMediaFilter = "" | "photo" | "video" | "raw" | "favorite";

/** Structured form state that is serialized to the query syntax parsed in Rust. */
export type MetadataSearchForm = {
  text: string;
  searchType: MetadataSearchType;
  person: string;
  place: string;
  camera: string;
  lens: string;
  tag: string;
  after: string;
  before: string;
  media: MetadataMediaFilter;
  /** Terms the form does not model (e.g. `rating:>=3`, negations); preserved verbatim. */
  extra: string;
};
