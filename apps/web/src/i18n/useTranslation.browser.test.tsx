import { expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { getI18nSnapshot, persistGTLocale } from "./runtime";
import { readLocale, setLocale, translateNow, useLocale, useTranslation } from "./useTranslation";

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

it("shares native locale changes with remaining community views", async () => {
  // This probe exercises the locale adapter without application navigation.
  await using screen = await render(<LocaleProbe />, { router: false });
  await expect.element(screen.getByRole("button", { name: "New thread" })).toBeVisible();
  await screen.getByRole("button", { name: "New thread" }).click();
  expect(getI18nSnapshot().locale).toBe("zh");
  await expect.element(screen.getByRole("button", { name: "新建会话" })).toBeVisible();
  expect(translateNow(messages, "New thread")).toBe("新建会话");
  await screen.getByRole("button", { name: "新建会话" }).click();
  expect(getI18nSnapshot().locale).toBe("en");
  await expect.element(screen.getByRole("button", { name: "New thread" })).toBeVisible();
  await act(() => persistGTLocale("de"));
  expect(getI18nSnapshot().locale).toBe("de");
  expect(readLocale()).toBe("en");
  await expect.element(screen.getByRole("button", { name: "New thread" })).toBeVisible();
});
