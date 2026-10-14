import type { Member } from "@furca/core/members/Member";
import { Dropdown, Kbd, Label, ListBox, Select, Separator, useTheme } from "@heroui/react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChartLine,
  Database,
  Flag,
  FlaskConical,
  History,
  KeyRound,
  Languages,
  Layers,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  UsersRound,
} from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { currentLocale, setLocale } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { Logo } from "./Logo";

export type NavKey =
  | "overview"
  | "flags"
  | "experiments"
  | "metrics"
  | "savedGroups"
  | "namespaces"
  | "dataSources"
  | "environments"
  | "audit"
  | "settings";

interface NavItem {
  readonly to: string;
  /** Key under `shell:nav` */
  readonly label: NavKey;
  readonly icon: ComponentType<{ className?: string }>;
}

export const primaryNav: ReadonlyArray<NavItem> = [
  { to: "/overview", label: "overview", icon: LayoutGrid },
  { to: "/flags", label: "flags", icon: Flag },
  { to: "/experiments", label: "experiments", icon: FlaskConical },
  { to: "/metrics", label: "metrics", icon: ChartLine },
];

export const secondaryNav: ReadonlyArray<NavItem> = [
  { to: "/saved-groups", label: "savedGroups", icon: UsersRound },
  { to: "/namespaces", label: "namespaces", icon: Layers },
  { to: "/data-sources", label: "dataSources", icon: Database },
  { to: "/environments", label: "environments", icon: KeyRound },
  { to: "/audit", label: "audit", icon: History },
  { to: "/settings", label: "settings", icon: Settings },
];

/** Stable hue per environment key so the same environment always reads the same color */
export const environmentHue = (key: string) =>
  key === "production" ? "bg-win" : key === "development" ? "bg-variation-1" : "bg-variation-2";

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const { t } = useTranslation("shell");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex h-8 items-center gap-2.5 rounded-md px-2 text-label transition-colors duration-150 ease-out-quart ${
        active ? "bg-default font-medium text-foreground" : "text-muted hover:bg-default/60 hover:text-foreground"
      }`}
    >
      <Icon className={`size-4 shrink-0 ${active ? "text-foreground" : "text-muted group-hover:text-foreground"}`} />
      {t(`nav.${item.label}`)}
    </Link>
  );
}

function EnvironmentSwitcher() {
  const { t } = useTranslation("shell");
  const { environments, current, select } = useEnvironment();
  if (current === null) return <div className="h-9" />;
  return (
    <Select
      aria-label={t("environment.label")}
      value={current.id}
      onChange={(id) => typeof id === "string" && select(id)}
      className="w-full"
    >
      <Select.Trigger className="h-9 w-full justify-between rounded-md border border-border bg-surface px-2.5 shadow-none">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`size-2 shrink-0 rounded-full ${environmentHue(current.key)}`} aria-hidden="true" />
          <Select.Value className="truncate text-label font-medium" />
        </span>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {environments.map((env) => (
            <ListBox.Item key={env.id} id={env.id} textValue={env.name}>
              <span className={`size-2 rounded-full ${environmentHue(env.key)}`} aria-hidden="true" />
              {env.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function UserMenu({ me, onSignOut }: { me: Member; onSignOut: () => void }) {
  const { t } = useTranslation("shell");
  const { theme, setTheme } = useTheme();
  const locale = currentLocale();
  const initials = (me.name || me.email).slice(0, 2).toUpperCase();
  return (
    <Dropdown>
      <Dropdown.Trigger className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-default/60 focus-visible:ring-2 focus-visible:ring-focus">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-default text-meta font-medium">
          {initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label font-medium">{me.name || me.email}</span>
          <span className="block truncate text-meta text-muted">{me.isOwner ? t("account.owner") : t("account.member")}</span>
        </span>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" className="min-w-56">
        <Dropdown.Menu
          aria-label={t("account.menu")}
          onAction={(key) => {
            if (key === "signout") onSignOut();
            else if (key === "lang:en" || key === "lang:ja") setLocale(key === "lang:ja" ? "ja" : "en");
            else if (key === "light" || key === "dark" || key === "system") setTheme(key);
          }}
        >
          <Dropdown.Section>
            <Dropdown.Item id="light" textValue={t("account.lightTheme")}>
              <Sun className="size-4" />
              <Label>{t("account.light")}{theme === "light" ? " ✓" : ""}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="dark" textValue={t("account.darkTheme")}>
              <Moon className="size-4" />
              <Label>{t("account.dark")}{theme === "dark" ? " ✓" : ""}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="system" textValue={t("account.systemTheme")}>
              <Monitor className="size-4" />
              <Label>{t("account.system")}{theme === "system" ? " ✓" : ""}</Label>
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          {/* Language names are always shown in their own language */}
          <Dropdown.Section aria-label={t("account.language")}>
            <Dropdown.Item id="lang:en" textValue="English">
              <Languages className="size-4" />
              <Label>English{locale === "en" ? " ✓" : ""}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="lang:ja" textValue="日本語">
              <Languages className="size-4" />
              <Label>日本語{locale === "ja" ? " ✓" : ""}</Label>
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          <Dropdown.Item id="signout" textValue={t("account.signOut")}>
            <LogOut className="size-4" />
            <Label>{t("account.signOut")}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

export function Sidebar({
  me,
  onSearch,
  onSignOut,
  onNavigate,
}: {
  me: Member;
  onSearch: () => void;
  onSignOut: () => void;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("shell");
  return (
    <nav aria-label={t("nav.main")} className="flex h-full flex-col gap-4 bg-surface-secondary px-3 py-4">
      <div className="px-1">
        <Link to="/overview" onClick={onNavigate} aria-label={t("nav.home")} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <Logo />
        </Link>
      </div>
      <EnvironmentSwitcher />
      <button
        type="button"
        onClick={onSearch}
        className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-label text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">{t("search.button")}</span>
        <Kbd className="text-meta">
          <Kbd.Abbr keyValue="command" />
          <Kbd.Content>K</Kbd.Content>
        </Kbd>
      </button>
      <div className="flex flex-col gap-0.5">
        {primaryNav.map((item) => (
          <NavLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border pt-4">
        {secondaryNav.map((item) => (
          <NavLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </div>
      <div className="mt-auto">
        <UserMenu me={me} onSignOut={onSignOut} />
      </div>
    </nav>
  );
}
