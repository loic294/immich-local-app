import type { BrowsingPerson } from "../types/browsing";

export function isNamedPerson(person: BrowsingPerson): boolean {
  return Boolean(person.name?.trim());
}

export function visiblePeople(
  people: BrowsingPerson[],
  search: string,
  hideUnnamed: boolean,
  sort: "name" | "count",
  unnamedLabel: string,
): BrowsingPerson[] {
  const needle = search.trim().toLocaleLowerCase();
  return people
    .filter(
      (person) =>
        !person.isHidden &&
        (!hideUnnamed || isNamedPerson(person)) &&
        (person.name?.trim() || unnamedLabel).toLocaleLowerCase().includes(needle),
    )
    .sort(
      (left, right) =>
        Number(isNamedPerson(right)) - Number(isNamedPerson(left)) ||
        (sort === "count" ? right.assetCount - left.assetCount : 0) ||
        (left.name?.trim() || unnamedLabel).localeCompare(right.name?.trim() || unnamedLabel) ||
        left.id.localeCompare(right.id),
    );
}
