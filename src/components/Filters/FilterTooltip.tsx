import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface FilterTooltipProps {
  content: string;
  children: ReactNode;
  className?: string;
}

interface TooltipPosition {
  left: number;
  top: number;
}

export function FilterTooltip({ content, children, className = "" }: FilterTooltipProps) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    setPosition({
      left: Math.min(Math.max(rect.left + rect.width / 2, 168), window.innerWidth - 168),
      top: rect.bottom,
    });
  }, []);

  const openTooltip = () => {
    updatePosition();
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, updatePosition]);

  return (
    <>
      <span
        ref={triggerRef}
        className={`inline-flex ${className}`}
        onMouseEnter={openTooltip}
        onMouseLeave={() => setIsOpen(false)}
        onFocusCapture={openTooltip}
        onBlurCapture={() => setIsOpen(false)}
      >
        {children}
      </span>
      {isOpen &&
        position &&
        createPortal(
          <span
            className="tooltip tooltip-open tooltip-bottom pointer-events-none z-100"
            data-tip={content}
            style={{
              position: "fixed",
              left: position.left,
              top: position.top,
            }}
          />,
          document.body,
        )}
    </>
  );
}
