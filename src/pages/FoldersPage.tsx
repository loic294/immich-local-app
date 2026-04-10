import { ChevronRight, Folder, House } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "../components/Layout/Header";
import { PageBackButton } from "../components/Layout/PageBackButton";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { useFolderAssets } from "../hooks/useFolderAssets";
import { useFolderPaths } from "../hooks/useFolderPaths";
import { getCachedFolderFullGridLayout } from "../api/tauri";
import type { Session } from "../hooks/useSession";

interface FoldersPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
}

export function FoldersPage({ session, onNavigate }: FoldersPageProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [searchInput, setSearchInput] = useState("");
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [photoGridHeight, setPhotoGridHeight] = useState(0);
  const folderPathsQuery = useFolderPaths(true);

  const paths = useMemo(
    () => (folderPathsQuery.data ?? []).map((path) => normalizePath(path)),
    [folderPathsQuery.data],
  );

  useEffect(() => {
    if (!paths.length) {
      return;
    }

    if (
      currentPath !== "/" &&
      !paths.some((path) => path.startsWith(currentPath))
    ) {
      setCurrentPath("/");
    }
  }, [currentPath, paths]);

  const assetsQuery = useFolderAssets(!folderPathsQuery.isLoading, currentPath);

  const allAssets = useMemo(
    () => assetsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [assetsQuery.data?.pages],
  );

  const subfolders = useMemo(
    () => getDirectChildFolders(paths, currentPath),
    [currentPath, paths],
  );

  const breadcrumbs = useMemo(() => getBreadcrumbs(currentPath), [currentPath]);
  const hasSubfolders = subfolders.length > 0;
  const hasFolderAssets = allAssets.length > 0;
  const shouldShowPhotoGrid =
    assetsQuery.isLoading || assetsQuery.isFetchingNextPage || hasFolderAssets;

  // Calculate PhotoGrid height dynamically, same as AlbumsPage / PhotosPage
  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const calculateHeight = () => {
      if (!contentRef.current) {
        return;
      }

      const container = contentRef.current;
      const folderHeader = container.querySelector(
        '[data-test="folder-header"]',
      ) as HTMLElement;
      const subfoldersSection = container.querySelector(
        '[data-test="subfolders"]',
      ) as HTMLElement;
      const errorAlert = container.querySelector(
        '[data-test="error-alert"]',
      ) as HTMLElement;

      const padding = 16;
      let usedHeight = padding;

      if (folderHeader) {
        usedHeight += folderHeader.offsetHeight + 8;
      }
      if (subfoldersSection) {
        usedHeight += subfoldersSection.offsetHeight + 8;
      }
      if (errorAlert) {
        usedHeight += errorAlert.offsetHeight + 8;
      }

      const containerTop = container.getBoundingClientRect().top;
      const containerHeight = window.innerHeight - containerTop - padding;
      const availableHeight = containerHeight - (usedHeight - padding);
      setPhotoGridHeight(Math.max(300, availableHeight));
    };

    calculateHeight();
    const resizeObserver = new ResizeObserver(calculateHeight);
    resizeObserver.observe(contentRef.current);
    const mutationObserver = new MutationObserver(() => {
      requestAnimationFrame(calculateHeight);
    });
    mutationObserver.observe(contentRef.current, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    window.addEventListener("resize", calculateHeight);

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", calculateHeight);
    };
  }, [currentPath]);

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="folders" onNavigate={onNavigate} />

      <section className="flex min-w-0 h-screen flex-col">
        <Header
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          serverUrl={session.serverUrl}
          userId={session.userId}
          userName={session.userName}
          searchPlaceholder="Search folder photos"
        />

        <section
          ref={contentRef}
          className="flex flex-col gap-2 p-2 sm:p-3 lg:p-4"
        >
          <div
            data-test="folder-header"
            className="shrink-0 flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <PageBackButton
                ariaLabel="Back"
                disabled={currentPath === "/"}
                onClick={() => setCurrentPath(getParentPath(currentPath))}
              />
              <h1 className="m-0 text-2xl font-bold text-base-content">
                Folders
              </h1>
            </div>

            <div className="flex items-center gap-1 text-xs text-base-content/70">
              {breadcrumbs.map((crumb) => (
                <button
                  key={crumb.path}
                  type="button"
                  className={`btn btn-ghost btn-xs px-2 ${crumb.path === currentPath ? "text-primary" : ""}`}
                  onClick={() => setCurrentPath(crumb.path)}
                >
                  {crumb.path === "/" ? <House size={12} /> : null}
                  <span>{crumb.label}</span>
                  <ChevronRight size={11} className="text-base-content/40" />
                </button>
              ))}
            </div>
          </div>

          {folderPathsQuery.isError ? (
            <div
              role="alert"
              data-test="error-alert"
              className="shrink-0 alert alert-error alert-soft text-sm"
            >
              <span>
                {(folderPathsQuery.error as Error | null)?.message ??
                  "Could not load folders"}
              </span>
            </div>
          ) : null}

          {hasSubfolders ? (
            <section data-test="subfolders" className="shrink-0">
              <h2 className="mb-2 mt-0 text-sm font-semibold uppercase tracking-wide text-base-content/60">
                Subfolders
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {subfolders.map((folder) => (
                  <button
                    key={folder.path}
                    type="button"
                    className="btn h-auto justify-start gap-2 rounded-xl bg-base-100 px-3 py-3 text-left normal-case text-base-content shadow-sm ring-1 ring-base-300/80"
                    onClick={() => setCurrentPath(folder.path)}
                  >
                    <Folder size={16} className="text-primary" />
                    <span className="truncate">{folder.name}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {assetsQuery.isError ? (
            <div
              role="alert"
              data-test="error-alert"
              className="shrink-0 alert alert-error alert-soft text-sm"
            >
              <span>
                {(assetsQuery.error as Error | null)?.message ??
                  "Could not load photos for this folder"}
              </span>
            </div>
          ) : shouldShowPhotoGrid ? (
            <PhotoGrid
              key={currentPath}
              assets={allAssets}
              isFetching={assetsQuery.isFetchingNextPage}
              hasNextPage={Boolean(assetsQuery.hasNextPage)}
              maxHeight={photoGridHeight}
              onLoadMore={() =>
                assetsQuery.fetchNextPage().then(() => undefined)
              }
              loadFullLayout={(containerWidth) =>
                getCachedFolderFullGridLayout(currentPath, containerWidth)
              }
            />
          ) : null}

          {!assetsQuery.isLoading &&
          !assetsQuery.isError &&
          !hasSubfolders &&
          !hasFolderAssets ? (
            <div className="rounded-xl bg-base-100 px-3 py-4 text-sm text-base-content/60 ring-1 ring-base-300/80">
              This folder is empty.
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function normalizePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/+$/g, "") || "/";
}

function getDirectChildFolders(paths: string[], parentPath: string) {
  const lookup = new Map<string, { name: string; path: string }>();

  for (const path of paths) {
    const normalized = normalizePath(path);
    if (normalized === parentPath) {
      continue;
    }

    const relative =
      parentPath === "/"
        ? normalized.slice(1)
        : normalized.startsWith(`${parentPath}/`)
          ? normalized.slice(parentPath.length + 1)
          : null;

    if (!relative) {
      continue;
    }

    const firstSegment = relative.split("/")[0];
    if (!firstSegment) {
      continue;
    }

    const childPath =
      parentPath === "/" ? `/${firstSegment}` : `${parentPath}/${firstSegment}`;

    if (!lookup.has(childPath)) {
      lookup.set(childPath, {
        name: firstSegment,
        path: childPath,
      });
    }
  }

  return [...lookup.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getParentPath(path: string): string {
  if (path === "/") {
    return "/";
  }

  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }

  return path.slice(0, index);
}

function getBreadcrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ label: "root", path: "/" }];

  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    crumbs.push({
      label: part,
      path: current,
    });
  }

  return crumbs;
}
