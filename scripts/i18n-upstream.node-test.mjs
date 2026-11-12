import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { localizationStatus, nativeChineseCandidates } from "./i18n-upstream.mjs";

NodeTest.test(
  "flags native Chinese catalogs and locale configuration but not unrelated content",
  () => {
    const files = [
      { path: "apps/web/src/locales/zh-CN.json", content: '{"hello":"你好"}' },
      {
        path: "packages/client-runtime/src/i18n/config.ts",
        content: 'const locales = ["en", "zh-Hans"];',
      },
      {
        path: "apps/mobile/src/localization/messages.ts",
        content: 'export const label = "简体中文";',
      },
      { path: "apps/web/src/i18n/config.test.ts", content: 'expect("zh-CN");' },
      { path: "apps/web/src/timestamp.ts", content: 'date.toLocaleString("zh-CN")' },
      { path: "docs/zh-CN.md", content: "简体中文说明" },
      { path: "apps/web/src/components/Chat.tsx", content: 'const example = "简体中文";' },
      { path: "apps/web/src/i18n/config.ts", content: 'const locales = ["en", "de"];' },
    ];
    NodeAssert.deepEqual(
      nativeChineseCandidates(files),
      files.slice(0, 3).map(({ path }) => path),
    );
  },
);

NodeTest.test("accepts reviewed GT catalogs but stops for a new localization architecture", () => {
  NodeAssert.equal(localizationStatus([]), "no-native-chinese-detected");
  NodeAssert.equal(localizationStatus([
    "apps/web/src/i18n/translations/zh.json",
    "apps/mobile/src/i18n/translations/zh.json",
  ]), "native-chinese-integrated");
  NodeAssert.equal(localizationStatus([
    "apps/web/src/i18n/translations/zh.json",
    "packages/shared/locales/zh-CN.json",
  ]), "review-upstream-localization");
});
