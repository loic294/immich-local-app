import { ChevronDown, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PersonSummary } from "../../types";
import { PersonThumbnail } from "./PersonThumbnail";

interface PeopleFilterProps {
  /** Selected person ID, or null for everyone. */
  value: string | null;
  people: PersonSummary[];
  isLoading: boolean;
  onChange: (value: string | null) => void;
}

function personLabel(person: PersonSummary): string {
  return person.name?.trim() || "Unnamed";
}

/**
 * People filter rendered as a dropdown styled like a select so each option can
 * show the person's face thumbnail (a native `<option>` cannot render images).
 *
 * The menu is rendered in a portal at `document.body` with fixed positioning so
 * it is never clipped by the filter bar's horizontal-scroll overflow. CSS
 * anchor positioning is intentionally avoided because it is unsupported by the
 * macOS WebKit webview; manual `getBoundingClientRect` positioning works on both
 * macOS (WKWebView) and Windows (WebView2).
 */
export function PeopleFilter({
  value,
  people,
  isLoading,
  onChange,
}: PeopleFilterProps) {
  const selected = people.find((person) => person.id === value) ?? null;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) {
      return;
    }
    const rect = button.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 224),
    });
  }, []);

  const toggle = () => {
    if (!open) {
      updatePosition();
    }
    setOpen((prev) => !prev);
  };

  const select = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const reposition = () => updatePosition();

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("resize", reposition);
    // Capture phase so we also react to scrolling inner containers.
    window.addEventListener("scroll", reposition, true);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, updatePosition]);

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-sm w-48 justify-between font-normal"
        aria-label="Filter by person"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="flex items-center gap-2 truncate">
          {selected ? (
            <>
              <PersonThumbnail
                personId={selected.id}
                name={selected.name}
                size={20}
              />
              <span className="truncate">{personLabel(selected)}</span>
            </>
          ) : (
            <span className="text-base-content/70">
              {isLoading ? "Loading…" : "All people"}
            </span>
          )}
        </span>
        <ChevronDown size={14} className="shrink-0" />
      </button>

      {open &&
        menuPos &&
        createPortal(
          <ul
            ref={menuRef}
            role="listbox"
            className="menu menu-sm fixed z-60 max-h-72 flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-200 p-2 shadow-lg"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
            }}
          >
            <li>
              <button
                type="button"
                className="flex items-center justify-between"
                onClick={() => select(null)}
              >
                <span>All people</span>
                {value === null && <Check size={14} />}
              </button>
            </li>
            {people.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  className="flex items-center justify-between gap-2"
                  onClick={() => select(person.id)}
                >
                  <span className="flex items-center gap-2 truncate">
                    <PersonThumbnail
                      personId={person.id}
                      name={person.name}
                      size={24}
                    />
                    <span className="truncate">{personLabel(person)}</span>
                  </span>
                  {value === person.id && (
                    <Check size={14} className="shrink-0" />
                  )}
                </button>
              </li>
            ))}
            {!isLoading && people.length === 0 && (
              <li className="menu-disabled">
                <span className="text-base-content/60">No people found</span>
              </li>
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
