import type { MetadataMediaFilter, MetadataSearchForm, MetadataSearchType } from "../types/search";

export const EMPTY_METADATA_SEARCH: MetadataSearchForm = {
  text: "",
  searchType: "context",
  person: "",
  place: "",
  camera: "",
  lens: "",
  tag: "",
  after: "",
  before: "",
  media: "",
  extra: "",
};

type Token = { key: string | null; value: string; negated: boolean; raw: string };

const SEARCH_TYPE_KEYS: Record<Exclude<MetadataSearchType, "context">, string> = {
  filename: "name",
  description: "description",
  path: "path",
};

const KEY_ALIASES: Record<string, string> = {
  filename: "name",
  file: "name",
  desc: "description",
  caption: "description",
  folder: "path",
  people: "person",
  face: "person",
  tags: "tag",
  location: "place",
  loc: "place",
  from: "after",
  since: "after",
  until: "before",
  to: "before",
  is: "type",
  media: "type",
};

/** Tokenizes like the Rust parser: `key:value`, `key:"quoted value"`, `-negation`. */
export function tokenizeMetadataQuery(input: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(-?)(?:([A-Za-z]+):)?("([^"]*)"?|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const [raw, dash, key, rawValue, quoted] = match;
    const value = (quoted ?? rawValue).trim();
    if (!value) continue;
    const normalizedKey = key ? (KEY_ALIASES[key.toLowerCase()] ?? key.toLowerCase()) : null;
    tokens.push({ key: normalizedKey, value, negated: dash === "-", raw });
  }
  return tokens;
}

function quote(value: string): string {
  const trimmed = value.trim().replace(/"/g, "");
  return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

/** Converts a raw query into the structured form; unmodeled terms land in `extra`. */
export function parseMetadataQuery(query: string): MetadataSearchForm {
  const form: MetadataSearchForm = { ...EMPTY_METADATA_SEARCH };
  const text: string[] = [];
  const extra: string[] = [];
  for (const token of tokenizeMetadataQuery(query)) {
    if (token.negated) {
      extra.push(token.raw);
      continue;
    }
    switch (token.key) {
      case null:
        text.push(token.value);
        break;
      case "name":
      case "description":
      case "path": {
        const type = (Object.keys(SEARCH_TYPE_KEYS) as Array<keyof typeof SEARCH_TYPE_KEYS>).find(
          (candidate) => SEARCH_TYPE_KEYS[candidate] === token.key,
        );
        if (
          type &&
          (form.searchType === "context" || form.searchType === type) &&
          text.length === 0
        ) {
          form.searchType = type;
          text.push(token.value);
        } else {
          extra.push(token.raw);
        }
        break;
      }
      case "person":
      case "place":
      case "camera":
      case "lens":
      case "tag":
      case "after":
      case "before":
        if (form[token.key]) extra.push(token.raw);
        else form[token.key] = token.value;
        break;
      case "type": {
        const value = token.value.toLowerCase();
        const media: MetadataMediaFilter | null =
          value === "photo" || value === "video" || value === "raw" || value === "favorite"
            ? value
            : null;
        if (media && !form.media) form.media = media;
        else extra.push(token.raw);
        break;
      }
      default:
        extra.push(token.raw);
    }
  }
  form.text = text.join(" ");
  form.extra = extra.join(" ");
  return form;
}

/** Serializes the structured form back to the query syntax. */
export function buildMetadataQuery(form: MetadataSearchForm): string {
  const parts: string[] = [];
  const text = form.text.trim();
  if (text) {
    parts.push(
      form.searchType === "context" ? text : `${SEARCH_TYPE_KEYS[form.searchType]}:${quote(text)}`,
    );
  }
  const fields: Array<[string, string]> = [
    ["person", form.person],
    ["place", form.place],
    ["camera", form.camera],
    ["lens", form.lens],
    ["tag", form.tag],
    ["after", form.after],
    ["before", form.before],
    ["type", form.media],
  ];
  for (const [key, value] of fields) {
    if (value.trim()) parts.push(`${key}:${quote(value)}`);
  }
  if (form.extra.trim()) parts.push(form.extra.trim());
  return parts.join(" ");
}

/** Number of structured (non free-text) terms in a query, for the badge. */
export function countMetadataFilters(query: string): number {
  return tokenizeMetadataQuery(query).filter((token) => token.key !== null || token.negated).length;
}
