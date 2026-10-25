/**
 * Kitty's logo, drawn the way Remora's is (apps/web/src/components/logo.tsx, ADR-0066): one
 * `currentColor` path, alone or on a rounded tile like an app icon, with a lowercase word beside it.
 * The mark is a cat's head; the eyes and nose are holes, so the tile shows through them.
 */
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export const LOGO_VIEWBOX = "0 0 24 24";
export const LOGO_PATH = [
  "M5 3.2L9.6 7.2H14.4L19 3.2A0.8 0.8 0 0 1 20.3 3.8V14A7 7 0 0 1 13.3 21H10.7A7 7 0 0 1 3.7 14V3.8A0.8 0.8 0 0 1 5 3.2Z",
  "M7.6 13.4A1.4 1.4 0 1 0 10.4 13.4A1.4 1.4 0 1 0 7.6 13.4Z",
  "M13.6 13.4A1.4 1.4 0 1 0 16.4 13.4A1.4 1.4 0 1 0 13.6 13.4Z",
  "M10.9 16.2H13.1L12 17.5Z",
].join("");

const WORD_TO_MARK = 0.78;
const GAP_TO_MARK = 0.3;
const TILE_PADDING = 0.18;
const TILE_RADIUS = 0.24;

export function LogoMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <path fill="currentColor" fillRule="evenodd" d={LOGO_PATH} />
    </svg>
  );
}

export function Logo({
  size = 24,
  withText = false,
  className,
}: {
  /** Height of the tile in px. */
  size?: number;
  /** Add the word "kitty" to the right of the mark. */
  withText?: boolean;
  className?: string;
}) {
  const glyph = Math.round(size * (1 - TILE_PADDING * 2));
  const word: CSSProperties = { fontSize: Math.round(size * WORD_TO_MARK), lineHeight: 1 };
  return (
    <span
      data-slot="logo"
      role="img"
      aria-label="Kitty"
      className={cn("inline-flex items-center", className)}
      style={{ gap: Math.round(size * GAP_TO_MARK) }}
    >
      <span
        data-slot="logo-tile"
        className="inline-flex shrink-0 items-center justify-center bg-primary"
        style={{ width: size, height: size, borderRadius: size * TILE_RADIUS }}
      >
        <LogoMark size={glyph} className="text-primary-foreground" />
      </span>
      {withText ? (
        <span aria-hidden className="font-semibold tracking-tight text-foreground" style={word}>
          kitty
        </span>
      ) : null}
    </span>
  );
}
