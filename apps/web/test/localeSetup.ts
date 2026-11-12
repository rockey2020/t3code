import { beforeEach, vi } from "vite-plus/test";

import { persistGTLocale } from "../src/i18n/runtime";

// View tests switch locale synchronously; native GT chunk loading is outside their scope.
vi.mock("../src/i18n/runtime", async () => {
  const { default: chinese } = await import("../src/i18n/translations/zh.json");
  const listeners = new Set<() => void>();
  let snapshot = { locale: "en", translations: { en: {}, zh: chinese } };
  return {
    getI18nSnapshot: () => snapshot,
    persistGTLocale: (locale: string) => {
      snapshot = { ...snapshot, locale };
      for (const listener of listeners) listener();
    },
    subscribeI18n: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    startI18n: () => {},
    whenLocaleReady: () => Promise.resolve(),
  };
});

beforeEach(() => persistGTLocale("en"));
