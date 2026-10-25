/**
 * The app shell, as in Remora (apps/web/src/app/app-layout.tsx, ADR-0066): an inset sidebar, and a
 * rounded content panel with a top bar holding the sidebar toggle, the page title on a phone, and the
 * network.
 */
import { type CSSProperties, useState } from "react";
import { Outlet } from "react-router";
import { NetworkPill } from "@/components/app/network-pill";
import { ThemeSync } from "@/components/app/theme-choice";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { ShellContext } from "./shell";

export function AppLayout() {
  const [title, setTitle] = useState("Kitty");
  return (
    <ShellContext.Provider value={{ setTitle }}>
      <SidebarProvider
        className="h-dvh min-h-0"
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 60)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as CSSProperties
        }
      >
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="flex h-(--header-height) shrink-0 items-center border-b">
            <div className="flex w-full items-center gap-1 px-2">
              <SidebarTrigger className="size-8" />
              <p className="min-w-0 flex-1 truncate pl-1 text-sm text-muted-foreground md:hidden">
                {title}
              </p>
              <div className="hidden flex-1 md:block" />
              <NetworkPill />
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <ThemeSync />
    </ShellContext.Provider>
  );
}
