import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enSavedGroups from "./locales/en/savedGroups.json";
import enNamespaces from "./locales/en/namespaces.json";
import enPlatform from "./locales/en/platform.json";
import enCharts from "./locales/en/charts.json";
import jaSavedGroups from "./locales/ja/savedGroups.json";
import jaNamespaces from "./locales/ja/namespaces.json";
import jaPlatform from "./locales/ja/platform.json";
import jaCharts from "./locales/ja/charts.json";
import enCommon from "./locales/en/common.json";
import enShell from "./locales/en/shell.json";
import enFlags from "./locales/en/flags.json";
import enTargeting from "./locales/en/targeting.json";
import enExperiments from "./locales/en/experiments.json";
import enResults from "./locales/en/results.json";
import enMetrics from "./locales/en/metrics.json";
import enDatasources from "./locales/en/datasources.json";
import enEnvironments from "./locales/en/environments.json";
import enAudit from "./locales/en/audit.json";
import enSettings from "./locales/en/settings.json";
import enOverview from "./locales/en/overview.json";
import jaCommon from "./locales/ja/common.json";
import jaShell from "./locales/ja/shell.json";
import jaFlags from "./locales/ja/flags.json";
import jaTargeting from "./locales/ja/targeting.json";
import jaExperiments from "./locales/ja/experiments.json";
import jaResults from "./locales/ja/results.json";
import jaMetrics from "./locales/ja/metrics.json";
import jaDatasources from "./locales/ja/datasources.json";
import jaEnvironments from "./locales/ja/environments.json";
import jaAudit from "./locales/ja/audit.json";
import jaSettings from "./locales/ja/settings.json";
import jaOverview from "./locales/ja/overview.json";

export const LOCALES = ["en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

/** Namespaces map 1:1 to UI areas, so each area's copy lives in its own file */
export const resources = {
  en: { common: enCommon, shell: enShell, flags: enFlags, targeting: enTargeting, experiments: enExperiments, results: enResults, metrics: enMetrics, datasources: enDatasources, environments: enEnvironments, audit: enAudit, settings: enSettings, overview: enOverview, savedGroups: enSavedGroups, namespaces: enNamespaces, platform: enPlatform, charts: enCharts },
  ja: { common: jaCommon, shell: jaShell, flags: jaFlags, targeting: jaTargeting, experiments: jaExperiments, results: jaResults, metrics: jaMetrics, datasources: jaDatasources, environments: jaEnvironments, audit: jaAudit, settings: jaSettings, overview: jaOverview, savedGroups: jaSavedGroups, namespaces: jaNamespaces, platform: jaPlatform, charts: jaCharts },
} as const;

const STORAGE_KEY = "furca-locale";

/** Saved choice, else the browser language, else English */
export const detectLocale = (): Locale => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ja") return saved;
  } catch {
    // storage unavailable (private mode): fall through to the browser language
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
};

void i18n.use(initReactI18next).init({
  resources,
  lng: typeof window === "undefined" ? "en" : detectLocale(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: Object.keys(resources.en),
  interpolation: { escapeValue: false },
  returnNull: false,
});

if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

export const setLocale = (locale: Locale) => {
  void i18n.changeLanguage(locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // not remembered in private mode
  }
  document.documentElement.lang = locale;
};

export const currentLocale = (): Locale => (i18n.language === "ja" ? "ja" : "en");

/** BCP 47 tag for Intl formatters and React Aria's I18nProvider */
export const intlLocale = (): "en-US" | "ja-JP" => (currentLocale() === "ja" ? "ja-JP" : "en-US");

export { i18n };
