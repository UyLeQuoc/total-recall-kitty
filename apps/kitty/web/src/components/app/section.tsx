// Copied from Remora: apps/web/src/components/app/section.tsx (ADR-0066).
/**
 * A titled group inside a page (plan §2.2): an `h2` and its content, with no card border, so a form
 * group or an info group stops looking like an object. `tone="danger"` is the Danger zone.
 * `layout="split"` puts the heading in a left column on wide screens and lets the content take the
 * rest of the page's width, the usual shape of a settings page.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({
  title,
  description,
  actions,
  tone = "default",
  layout = "stack",
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: "default" | "danger";
  layout?: "stack" | "split";
  children: ReactNode;
}) {
  const split = layout === "split";
  return (
    <section
      className={cn(
        "flex flex-col gap-4",
        split && "lg:grid lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:gap-x-12",
        tone === "danger" && "rounded-xl border border-destructive/30 p-4",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="flex min-h-8 items-center text-base font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center">{actions}</div> : null}
      </div>
      {split ? <div className="flex min-w-0 flex-col gap-4">{children}</div> : children}
    </section>
  );
}
