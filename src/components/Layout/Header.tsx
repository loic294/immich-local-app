import { Search, Upload } from "lucide-react";

interface HeaderProps {
  searchInput: string;
  onSearchChange: (value: string) => void;
  serverUrl: string;
}

export function Header({
  searchInput,
  onSearchChange,
  serverUrl,
}: HeaderProps) {
  return (
    <header className="navbar border-b border-base-300 bg-base-100 px-3 sm:px-4">
      <div className="navbar-start">
        <label
          className="input input-bordered flex w-full min-w-[16rem] items-center gap-2 rounded-full sm:min-w-[20rem] lg:min-w-md"
          htmlFor="asset-search"
        >
          <Search size={16} className="text-base-content/60" />
          <input
            id="asset-search"
            placeholder="Search your photos"
            type="text"
            className="grow"
            value={searchInput}
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
          />
        </label>
      </div>

      <div className="navbar-end gap-2">
        <button className="btn btn-sm btn-ghost" type="button">
          <Upload size={14} className="shrink-0" />
          <span>Upload</span>
        </button>
        <div className="flex items-center gap-2">
          <div className="avatar placeholder">
            <div className="w-8 rounded-full bg-primary text-primary-content text-xs font-bold">
              LB
            </div>
          </div>
          <div>
            <p className="m-0 text-xs font-semibold text-base-content">Loic</p>
            <p className="m-0 max-w-40 truncate text-[11px] text-base-content/60">
              {serverUrl}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
