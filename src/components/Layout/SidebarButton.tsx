import type { ReactNode } from "react";

interface SidebarButtonProps {
  leading: ReactNode;
  label: string;
  isActive?: boolean;
  ariaLabel?: string;
  onClick: () => void;
}

export function SidebarButton({
  leading,
  label,
  isActive = false,
  ariaLabel,
  onClick,
}: SidebarButtonProps) {
  return (
    <button
      className={`btn btn-md btn-block h-12 min-w-0 w-full max-w-none justify-start gap-3 px-3 text-left text-base font-semibold ${isActive ? "btn-soft btn-primary" : "btn-ghost"}`}
      type="button"
      aria-label={ariaLabel}
      aria-current={isActive ? "page" : undefined}
      title={label}
      onClick={onClick}
    >
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center">
        {leading}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
