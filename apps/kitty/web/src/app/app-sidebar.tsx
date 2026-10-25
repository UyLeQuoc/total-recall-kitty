/**
 * Kitty's sidebar, in Remora's shape (apps/web/src/app/app-sidebar.tsx, ADR-0066): the logo, the main
 * links, the pot you're on, your pots, and the wallet in the footer.
 */
import { useCurrentAccount } from "@mysten/dapp-kit";
import { Brain, Coins, PiggyBank, SquarePen } from "lucide-react";
import { Link, useLocation } from "react-router";
import { usePot, useWallet } from "@/api";
import { AccountMenu } from "@/components/app/account-menu";
import { Logo } from "@/components/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const POT = /^\/pots\/(0x[0-9a-fA-F]+)(\/learned)?\/?$/;

export function AppSidebar() {
  const { state, setOpenMobile } = useSidebar();
  const closeOnPhone = () => setOpenMobile(false);
  const { pathname, search } = useLocation();
  const collapsed = state === "collapsed";
  const account = useCurrentAccount();
  const wallet = useWallet(account?.address);
  const potId = POT.exec(pathname)?.[1] ?? "";
  const pot = usePot(potId);
  const mine = wallet.data?.pots ?? [];

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <Link to="/" className="flex items-center rounded-md px-2 py-1.5" onClick={closeOnPhone}>
          <Logo size={collapsed ? 24 : 28} withText={!collapsed} />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/" && search.includes("start")}
                  tooltip="New pot"
                >
                  <Link to="/?start=1" onClick={closeOnPhone}>
                    <SquarePen />
                    <span>New pot</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/" && !search.includes("start")}
                  tooltip="Pots"
                >
                  <Link to="/" onClick={closeOnPhone}>
                    <PiggyBank />
                    <span>Pots</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {potId ? (
          <SidebarGroup>
            <SidebarGroupLabel>
              <span className="min-w-0 truncate">{pot.data?.pot.name ?? "This pot"}</span>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === `/pots/${potId}`}
                    tooltip="The pot"
                  >
                    <Link to={`/pots/${potId}`} onClick={closeOnPhone}>
                      <Coins />
                      <span>The pot</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname.endsWith("/learned")}
                    tooltip="What Kitty learned"
                  >
                    <Link to={`/pots/${potId}/learned`} onClick={closeOnPhone}>
                      <Brain />
                      <span>What Kitty learned</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        {!collapsed && mine.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel>Your pots</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {mine.map((p) => (
                  <SidebarMenuItem key={p.potId}>
                    <SidebarMenuButton asChild isActive={p.potId === potId}>
                      <Link to={`/pots/${p.potId}`} onClick={closeOnPhone}>
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {p.closed || !p.active ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {p.closed ? "closed" : "left"}
                          </span>
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarFooter className="gap-2">
        <AccountMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
