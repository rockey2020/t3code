import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { getI18nSnapshot, persistGTLocale, subscribeI18n } from "./runtime";
import { readLocale, setLocale, translateNow, useLocale, useTranslation } from "./useTranslation";

vi.mock("./runtime", () => ({
  getI18nSnapshot: vi.fn(),
  persistGTLocale: vi.fn(),
  subscribeI18n: vi.fn(),
}));

const messages = { "New thread": "新建会话" } as const;

function LocaleProbe() {
  const t = useTranslation(messages);
  const locale = useLocale();
  return (
    <button type="button" onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>
      {t("New thread")}
    </button>
  );
}

it("shares native locale changes and persistence with remaining community views", async () => {
  vi.mocked(persistGTLocale).mockReset();
  const listeners = new Set<() => void>();
  vi.mocked(subscribeI18n).mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.mocked(getI18nSnapshot).mockReturnValue({ locale: "en", translations: {} });
  // This probe exercises the locale adapter without application navigation.
  await using screen = await render(<LocaleProbe />, { router: false });
  await screen.getByRole("button", { name: "New thread" }).click();
  expect(persistGTLocale).toHaveBeenCalledWith("zh");
  await act(() => {
    vi.mocked(getI18nSnapshot).mockReturnValue({ locale: "zh", translations: {} });
    for (const listener of listeners) listener();
  });
  await expect.element(screen.getByRole("button", { name: "新建会话" })).toBeVisible();
  expect(translateNow(messages, "New thread")).toBe("新建会话");
  await screen.getByRole("button", { name: "新建会话" }).click();
  expect(persistGTLocale).toHaveBeenLastCalledWith("en");
  await act(() => {
    vi.mocked(getI18nSnapshot).mockReturnValue({ locale: "de", translations: {} });
    for (const listener of listeners) listener();
  });
  expect(readLocale()).toBe("en");
  await expect.element(screen.getByRole("button", { name: "New thread" })).toBeVisible();
});
