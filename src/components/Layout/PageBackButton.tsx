import { ArrowLeft } from "lucide-react";

interface PageBackButtonProps {
  onClick: () => void;
  ariaLabel: string;
  disabled?: boolean;
}

export function PageBackButton({
  onClick,
  ariaLabel,
  disabled = false,
}: PageBackButtonProps) {
  return (
    <button
      type="button"
      className="btn btn-sm btn-circle btn-primary"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
    >
      <ArrowLeft size={16} />
    </button>
  );
}
