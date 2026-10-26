import { Button, Drawer, Spinner } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate, Outlet, useNavigate } from "@tanstack/react-router";
import { Menu as MenuIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandPalette } from "~/components/shell/CommandPalette";
import { Logo } from "~/components/shell/Logo";
import { Sidebar } from "~/components/shell/Sidebar";
import { authClient } from "~/lib/auth-client";
import { EnvironmentProvider } from "~/lib/environment";
import { isUnauthorized, orpc } from "~/lib/rpc";

/** Authenticated app shell. Client-rendered: everything inside needs the session */
export const Route = createFileRoute("/_app")({
  ssr: false,
  component: AppLayout,
});

function AppLayout() {
  const { t } = useTranslation(["shell", "common"]);
  const me = useQuery({ ...orpc.session.me.queryOptions(), retry: false, staleTime: 60_000 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  if (me.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center" aria-busy="true">
        <Spinner size="sm" color="current" />
      </div>
    );
  }
  if (me.error !== null) {
    if (isUnauthorized(me.error)) return <Navigate to="/login" />;
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 text-body">
        <p>{t(($) => $.session.loadFailed)}</p>
        <Button size="sm" variant="outline" onPress={() => me.refetch()}>
          {t(($) => $.actions.retry, { ns: "common" })}
        </Button>
      </div>
    );
  }

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: "/login" });
  };
  const sidebarProps = { me: me.data, onSearch: () => setPaletteOpen(true), onSignOut: signOut };

  return (
    <EnvironmentProvider>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-border lg:block">
          <Sidebar {...sidebarProps} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-(--z-sticky) flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur lg:hidden">
            <Button isIconOnly variant="ghost" size="sm" aria-label={t(($) => $.nav.openNavigation)} onPress={() => setDrawerOpen(true)}>
              <MenuIcon className="size-4" />
            </Button>
            <Logo />
          </header>
          <main className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">
            <Outlet />
          </main>
        </div>
      </div>
      <Drawer.Backdrop isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
        <Drawer.Content placement="left" className="w-72 p-0">
          <Drawer.Dialog aria-label={t(($) => $.nav.navigation)} className="h-full p-0">
            <Sidebar {...sidebarProps} onNavigate={() => setDrawerOpen(false)} />
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
      <CommandPalette isOpen={paletteOpen} onOpenChange={setPaletteOpen} />
    </EnvironmentProvider>
  );
}
