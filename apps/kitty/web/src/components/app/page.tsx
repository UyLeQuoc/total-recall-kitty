/**
 * The one place a page's width, padding, scroll area and document title are decided, as in Remora
 * (apps/web/src/components/app/page.tsx, ADR-0066): the full width of the shell with one gutter. A form
 * that would stretch unreadably constrains its own fields.
 */
import { type ReactNode, useEffect } from "react";
import { useShellTitle } from "@/app/shell";
import { cn } from "@/lib/utils";

export function Page({
  title,
  className,
  children,
}: {
  /** Also the document title: "Pots" renders "Pots · Kitty". */
  title: string;
  className?: string;
  children: ReactNode;
}) {
  useShellTitle(title);
  useEffect(() => {
    document.title =
      title === "Kitty" ? "Kitty · the group pot that saves itself" : `${title} · Kitty`;
  }, [title]);
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
      <div
        data-slot="page-column"
        className={cn("flex w-full flex-col px-4 py-6 sm:px-6 md:py-8 lg:px-10", className)}
      >
        <div className="flex w-full flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}

export { PageHeader } from "./page-header";
export { Section } from "./section";
