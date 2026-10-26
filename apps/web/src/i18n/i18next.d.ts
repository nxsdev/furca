import "i18next";
import type { resources } from "./index";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    enableSelector: true;
    resources: (typeof resources)["en"];
  }
}
