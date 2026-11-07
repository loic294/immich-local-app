import type { AlbumShareUser, AlbumSummary, AlbumUserCandidate, AlbumUserRole } from "../types";

interface NamedPerson {
  id: string;
  name: string | null;
  email: string | null;
}

/** Narrows a server role to one an owner may grant; anything else is unknown. */
export function toAlbumUserRole(role: string | null): AlbumUserRole | null {
  return role === "editor" || role === "viewer" ? role : null;
}

/** The name shown for a person: their name, else their email, else their id. */
export function personLabel(person: NamedPerson): string {
  return person.name?.trim() || person.email?.trim() || person.id;
}

/** The line shown under a person's name: their email, when it adds information. */
export function personDetail(person: NamedPerson): string | null {
  const email = person.email?.trim();
  return email && email !== personLabel(person) ? email : null;
}

/** Server users who can still be added: everyone except the owner and current members. */
export function addableUsers(
  candidates: AlbumUserCandidate[],
  ownerId: string,
  members: AlbumShareUser[],
): AlbumUserCandidate[] {
  const taken = new Set([ownerId, ...members.map((member) => member.id)]);
  return candidates.filter((candidate) => !taken.has(candidate.id));
}

/**
 * Flags one album as shared in a cached album list. The list is returned as-is
 * (same reference) when nothing changes so the query cache does not re-render.
 */
export function markAlbumShared(
  albums: AlbumSummary[] | undefined,
  albumId: string,
): AlbumSummary[] | undefined {
  if (!albums?.some((album) => album.id === albumId && !album.shared)) {
    return albums;
  }
  return albums.map((album) => (album.id === albumId ? { ...album, shared: true } : album));
}
