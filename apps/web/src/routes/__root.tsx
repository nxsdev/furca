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
import type { ReactNode } from "react";
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
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#171717"/><rect x="8" y="9" width="3" height="16" rx="1.5" fill="#fff"/><rect x="14.5" y="6" width="3" height="19" rx="1.5" fill="#fff"/><rect x="14.5" y="6" width="3" height="5" rx="1.5" fill="#d23c6f"/><rect x="21" y="11" width="3" height="14" rx="1.5" fill="#fff"/></svg>`,
)}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "kuji" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: faviconSvg },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

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
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        navigate={(to, options) => router.navigate({ ...options, to })}
        useHref={(to) => router.buildLocation({ to }).href}
      >
        <I18nProvider locale="en-US">
          <Outlet />
          <Toast.Provider placement="bottom end" />
        </I18nProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}
