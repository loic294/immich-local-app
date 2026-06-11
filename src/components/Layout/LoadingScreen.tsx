import logoUrl from "../../assets/logo.svg";

export function LoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-base-200 p-6">
      <section className="card w-full max-w-md border border-base-300 bg-base-100 shadow-xl">
        <div className="card-body">
          <img src={logoUrl} alt="" className="mb-2 h-14 w-14 rounded-lg" />
          <h1 className="card-title text-2xl">Immich Local App</h1>
          <p className="text-sm text-base-content/70">
            Restoring previous session...
          </p>
        </div>
      </section>
    </main>
  );
}
