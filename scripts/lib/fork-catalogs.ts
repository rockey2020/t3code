// @effect-diagnostics nodeBuiltinImport:off
// Reads native GT catalogs and the remaining desktop/community translations as data.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
export const SNAPSHOT_PATH = "i18n/zh-CN.json";

const CJK = /[一-鿿]/;
const ENTRY =
  /^\s*(?:"(?<double>(?:[^"\\]|\\.)*)"|'(?<single>(?:[^'\\]|\\.)*)'|\[`(?<template>(?:[^`\\]|\\.)*)`\]|(?<bare>[A-Za-z_$][\w$]*))\s*:\s*(?:\n\s*)?(?:"(?<value>(?:[^"\\]|\\.)*)"|`(?<templateValue>(?:[^`\\]|\\.)*)`)/gm;
const CJK_LITERAL =
  /(?:"(?:[^"\\\n]|\\.)*[一-鿿](?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*[一-鿿](?:[^`\\\n]|\\.)*`)/g;

const unescape = (raw: string): string => JSON.parse(`"${raw}"`);
const templateText = (raw: string) =>
  unescape(raw.replace(/\$\{(\w+)\}/g, "{$1}").replace(/"/g, '\\"'));

export interface CatalogEntry {
  readonly file: string;
  readonly at: string;
  readonly source: string;
  readonly localized: string;
}

export function readCatalogs() {
  const files = NodeChildProcess.execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "apps/web/src",
      "apps/desktop/src",
      "packages",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .sort()
    .filter((file) => NodeFS.existsSync(NodePath.join(repoRoot, file)))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file));
  const entries: CatalogEntry[] = [];
  const unparsed: string[] = [];
  for (const file of files) {
    const text = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");
    if (!CJK.test(text)) continue;
    const found = [...text.matchAll(ENTRY)].filter((match) =>
      CJK.test(match.groups?.value ?? match.groups?.templateValue ?? ""),
    );
    // Files with Chinese but no catalog entries (search keywords, language names) are not catalogs.
    if (found.length === 0) continue;
    for (const match of found) {
      const line = text.slice(0, match.index).split("\n").length;
      entries.push({
        file,
        at: `${file}:${line}`,
        source:
          match.groups?.template !== undefined
            ? templateText(match.groups.template)
            : match.groups?.single !== undefined
              ? unescape(match.groups.single.replace(/\\'/g, "'").replace(/"/g, '\\"'))
              : unescape(match.groups?.double ?? match.groups?.bare ?? ""),
        localized:
          match.groups?.templateValue !== undefined
            ? templateText(match.groups.templateValue)
            : unescape(match.groups?.value ?? ""),
      });
    }
    const literals = text.match(CJK_LITERAL)?.length ?? 0;
    if (literals !== found.length) unparsed.push(`${file}: ${literals - found.length}`);
  }
  for (const app of ["web", "mobile"]) {
    const directory = `apps/${app}/src/i18n/translations`;
    const source: Record<string, string> = JSON.parse(
      NodeFS.readFileSync(NodePath.join(repoRoot, directory, "en.json"), "utf8"),
    );
    const localized: Record<string, string> = JSON.parse(
      NodeFS.readFileSync(NodePath.join(repoRoot, directory, "zh.json"), "utf8"),
    );
    for (const [key, text] of Object.entries(source)) {
      entries.push({
        file: `${directory}/zh.json`,
        at: `${directory}/zh.json:${key}`,
        source: text,
        localized: localized[key] ?? "",
      });
    }
  }
  return { entries, unparsed };
}

/** Every English → Chinese pair, grouped by the catalog file that holds it. */
export function snapshotText(entries: ReadonlyArray<CatalogEntry>): string {
  const byFile: Record<string, Record<string, string>> = {};
  for (const entry of entries) (byFile[entry.file] ??= {})[entry.source] = entry.localized;
  return `${JSON.stringify(byFile, null, 2)}\n`;
}
