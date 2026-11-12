import { useSyncExternalStore } from "react";

import { translate, type Locale } from "./locale";
import { getI18nSnapshot, persistGTLocale, subscribeI18n } from "./runtime";

// Existing community catalogs share upstream's locale until their views migrate to GT.
export function readLocale(): Locale {
  return getI18nSnapshot().locale === "zh" ? "zh-CN" : "en";
}

export function setLocale(locale: Locale): void {
  persistGTLocale(locale === "zh-CN" ? "zh" : locale);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeI18n, readLocale, readLocale);
}

export function useTranslation<const Messages extends Readonly<Record<string, string>>>(
  messages: Messages,
) {
  const locale = useLocale();
  return (
    key: Extract<keyof Messages, string>,
    params?: Readonly<Record<string, string | number>>,
  ) => translate(locale, messages, key, params);
}

export function translateNow<const Messages extends Readonly<Record<string, string>>>(
  messages: Messages,
  key: Extract<keyof Messages, string>,
  params?: Readonly<Record<string, string | number>>,
): string {
  return translate(readLocale(), messages, key, params);
}
