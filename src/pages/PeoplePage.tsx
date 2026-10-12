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
import { AssignPersonDialog } from "../components/People/AssignPersonDialog";
import { visiblePeople as filterPeople } from "../utils/people";

interface PeoplePageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
}

export function PeoplePage({ session, onNavigate, onLogout }: PeoplePageProps) {
  const t = useBrowsingI18n();
  const people = usePeople(session);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "count">(() =>
    sessionStorage.getItem("people-sort") === "count" ? "count" : "name",
  );
  const [selected, setSelected] = useState<BrowsingPerson | null>(null);
  const [showUnnamed, setShowUnnamed] = useState(true);
  const [assigning, setAssigning] = useState<BrowsingPerson | null>(null);
  const assignmentDialog = assigning ? (
    <AssignPersonDialog
      key={`${assigning.accountId}:${assigning.id}`}
      person={assigning}
      onClose={() => setAssigning(null)}
      onAssigned={() => {
        setAssigning(null);
        setSelected(null);
      }}
    />
  ) : null;
  if (selected) {
    return (
      <>
        <PhotosPage
          key={selected.id}
          session={session}
          onNavigate={onNavigate}
          onNavigateRoot={() => {
            console.info("[navigation] returning to people collection", { personId: selected.id });
            setSelected(null);
            setAssigning(null);
          }}
          onLogout={onLogout}
          activePage="people"
          initialPersonId={selected.id}
          hideFilterBar
          pageHeader={
            <PersonHeader
              person={selected}
              onBack={() => setSelected(null)}
              onAssign={() => setAssigning(selected)}
            />
          }
        />
        {assignmentDialog}
      </>
    );
  }
  const visiblePeople = filterPeople(people.data ?? [], search, !showUnnamed, sort, t("unnamed"));
  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="people" onNavigate={onNavigate} onNavigateRoot={() => {}} />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppTopBar
          session={session}
          onLogout={onLogout}
          searchInput={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("searchPeople")}
        />
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-3 p-4"
          data-test="people-header"
        >
          <h1 className="text-2xl font-semibold">{t("people")}</h1>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={showUnnamed}
              onChange={(event) => {
                setShowUnnamed(event.target.checked);
                console.log("[browsing.people] unnamed filter changed", {
                  showUnnamed: event.target.checked,
                });
              }}
            />
            {t("showUnnamed")}
          </label>
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
        <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-test="people-scroll">
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
                key={`${person.accountId}:${person.id}`}
                person={person}
                onAssign={() => setAssigning(person)}
                onClick={() => {
                  console.log("[browsing.people] opening person timeline", { personId: person.id });
                  setSelected(person);
                }}
              />
            ))}
          </div>
        </section>
        {assignmentDialog}
      </section>
    </main>
  );
}
