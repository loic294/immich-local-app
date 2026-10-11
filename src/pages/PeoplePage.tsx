import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { AppTopBar } from "../components/Layout/AppTopBar";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
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
  const [selected, setSelected] = useState<BrowsingPerson | null>(null);
  if (selected) {
    return (
      <>
        <PhotosPage
          key={selected.id}
          session={session}
          onNavigate={onNavigate}
          onLogout={onLogout}
          activePage="people"
          initialPersonId={selected.id}
        />
        <button
          type="button"
          className="btn btn-sm btn-primary fixed bottom-4 left-4 z-30 lg:left-64"
          onClick={() => setSelected(null)}
        >
          <ArrowLeft size={16} /> {t("backPeople")}: {selected.name || t("unnamed")}
        </button>
      </>
    );
  }
  const visiblePeople = (people.data ?? []).filter((person) =>
    (person.name || t("unnamed")).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="people" onNavigate={onNavigate} />
      <section className="min-w-0">
        <AppTopBar
          session={session}
          onLogout={onLogout}
          searchInput={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("searchPeople")}
        />
        <section className="p-4">
          <h1 className="mb-4 text-2xl font-semibold">{t("people")}</h1>
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
