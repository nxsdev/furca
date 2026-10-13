import { I18nProvider, RouterProvider, Toast } from "@heroui/react";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  type NavigateOptions,
  Outlet,
  Scripts,
  type ToOptions,
  useRouter,
} from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import "~/i18n";
import { i18n, intlLocale } from "~/i18n";
import appCss from "../styles/app.css?url";

declare module "react-aria-components" {
  interface RouterConfig {
    href: ToOptions["to"];
    routerOptions: Omit<NavigateOptions, keyof ToOptions>;
  }
}

// Applies the stored / system theme before first paint (mirrors HeroUI's useTheme storage key)
const themeScript = `(()=>{try{let t=localStorage.getItem("heroui-theme")||"system";if(t==="system")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";const d=document.documentElement;d.classList.add(t);d.setAttribute("data-theme",t)}catch{}})()`;

const faviconSvg = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#171717"/><path d="M16 25.5V17.5C16 14.5 13.5 12.5 10.5 10.5M16 17.5C16 14.5 18.5 12.5 21.5 10.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="21.5" cy="10.5" r="2.6" fill="#d23c6f"/></svg>`,
)}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "furca" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: faviconSvg },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: NotFound,
});

function NotFound() {
  const { t } = useTranslation("shell");
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="font-mono text-label text-muted">404</p>
      <h1 className="text-title font-semibold tracking-tight">{t("notFound.title")}</h1>
      <a href="/overview" className="text-body text-link underline-offset-4 hover:underline">
        {t("notFound.back")}
      </a>
    </div>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint: inline theme bootstrap must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const router = useRouter();
  const { queryClient } = Route.useRouteContext();
  // Re-renders the tree (and React Aria's number/date formatting) when the language changes
  useTranslation();
  // head() titles are computed by the router, so re-run them on a language switch
  useEffect(() => {
    const refresh = () => void router.invalidate();
    i18n.on("languageChanged", refresh);
    return () => i18n.off("languageChanged", refresh);
  }, [router]);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        navigate={(to, options) => router.navigate({ ...options, to })}
        useHref={(to) => router.buildLocation({ to }).href}
      >
        <I18nProvider locale={intlLocale()}>
          <Outlet />
          <Toast.Provider placement="bottom end" />
        </I18nProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}
