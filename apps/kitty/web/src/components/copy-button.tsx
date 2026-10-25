// Copied from Remora: apps/web/src/components/copy-button.tsx (ADR-0066).
import { Check, Copy } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const COPIED_FOR_MS = 1000;

export function CopyButton({
  value,
  label,
  variant = "outline",
  size = "icon",
  className,
  disabled,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "value" | "children"> & {
  value: string;
  label: string;
  variant?: "outline" | "ghost";
  size?: "icon" | "icon-sm";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(() => {
    if (copied) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(value).then(
      () => {
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          setCopied(false);
        }, COPIED_FOR_MS);
      },
      () => {
        setCopied(false);
      },
    );
  }, [copied, value]);

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      {...props}
      type="button"
      disabled={copied || disabled}
      onClick={(event) => {
        onClick?.(event);
        copy();
      }}
      aria-label={copied ? "Copied" : `Copy ${label}`}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}
