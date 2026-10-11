import { useState } from "react";
import { AppTopBar } from "../components/Layout/AppTopBar";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { PersonHeader } from "../components/People/PersonHeader";
import { PersonCard } from "../components/People/PersonCard";
import type { Session } from "../hooks/useSession";
import { usePeople } from "../hooks/usePeople";
import { useBrowsingI18n } from "../i18n/browsing";
import { PhotosPage } from "./PhotosPage";
import type { BrowsingPerson } from "../types/browsing";

interface PeoplePageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
}

export function PeoplePage({ session, onNavigate, onLogout }: PeoplePageProps) {
  const t = useBrowsingI18n();
  const people = usePeople();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "count">(() =>
    sessionStorage.getItem("people-sort") === "count" ? "count" : "name",
  );
  const [selected, setSelected] = useState<BrowsingPerson | null>(null);
  if (selected) {
    return (
      <PhotosPage
        key={selected.id}
        session={session}
        onNavigate={onNavigate}
        onLogout={onLogout}
        activePage="people"
        initialPersonId={selected.id}
        hideFilterBar
        pageHeader={<PersonHeader person={selected} onBack={() => setSelected(null)} />}
      />
    );
  }
  const visiblePeople = (people.data ?? [])
    .filter((person) =>
      (person.name || t("unnamed")).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    )
    .sort((left, right) => {
      const byName = (left.name || t("unnamed")).localeCompare(right.name || t("unnamed"));
      return (
        (sort === "count" ? right.assetCount - left.assetCount : 0) ||
        byName ||
        left.id.localeCompare(right.id)
      );
    });
  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="people" onNavigate={onNavigate} />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppTopBar
          session={session}
          onLogout={onLogout}
          searchInput={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("searchPeople")}
        />
        <section className="min-h-0 flex-1 overflow-y-auto p-4" data-test="people-scroll">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">{t("people")}</h1>
            <div className="join" role="group" aria-label={t("sortPeople")}>
              {(["name", "count"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`btn btn-sm join-item ${sort === value ? "btn-primary" : "btn-ghost"}`}
                  aria-pressed={sort === value}
                  onClick={() => {
                    setSort(value);
                    sessionStorage.setItem("people-sort", value);
                    console.log("[browsing.people] sort changed", { sort: value });
                  }}
                >
                  {t(value === "name" ? "sortName" : "sortPhotoCount")}
                </button>
              ))}
            </div>
          </div>
          {people.error || people.refreshError ? (
            <div className="alert alert-warning mb-4">
              {String(people.error ?? people.refreshError)}
            </div>
          ) : null}
          {people.isPending ? <span className="loading loading-spinner" /> : null}
          {!people.isPending && visiblePeople.length === 0 ? <p>{t("peopleEmpty")}</p> : null}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {visiblePeople.map((person) => (
              <PersonCard
                key={person.id}
                person={person}
                onClick={() => {
                  console.log("[browsing.people] opening person timeline", { personId: person.id });
                  setSelected(person);
                }}
              />
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
