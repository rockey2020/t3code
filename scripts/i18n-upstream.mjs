import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

export function nativeChineseCandidates(files) {
  return files
    .filter(({ path, content }) => {
      if (!/^(apps\/(web|desktop|mobile)|packages)\//.test(path)) return false;
      if (/\.(test|spec)\.|\/test\/|\.md$/.test(path)) return false;
      const catalog = /(?:^|\/)(?:zh[-_](?:CN|Hans)|zh)(?:[/.]|$)/i.test(path);
      const localeCode = /["'`](?:zh[-_](?:CN|Hans)|简体中文)["'`]/.test(content);
      const infrastructure = /i18n|locales?|translations?|messages/i.test(path);
      return catalog || (infrastructure && localeCode);
    })
    .map(({ path }) => path);
}

export function inspectUpstream(ref) {
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  const paths = git("ls-tree", "-r", "--name-only", commit)
    .trim()
    .split("\n")
    .filter((path) => /^(apps\/(web|desktop|mobile)|packages)\//.test(path))
    .filter((path) => /(?:i18n|locales?|translations?|messages|zh[-_](?:cn|hans))/i.test(path))
    .filter((path) => /\.(?:[cm]?[jt]sx?|json|strings|xml)$/.test(path));
  const candidates = nativeChineseCandidates(
    paths.map((path) => ({ path, content: git("show", `${commit}:${path}`) })),
  );
  return {
    ref,
    commit,
    candidates,
    status: candidates.length ? "review-upstream-localization" : "no-native-chinese-detected",
    message: candidates.length
      ? "Upstream may now implement Simplified Chinese. Stop automatic localization import and adapt this fork to upstream's runtime/catalogs before continuing."
      : "No native Simplified Chinese catalog was detected. This is a heuristic; review upstream release notes and localization changes too.",
  };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const result = inspectUpstream(process.argv[2] ?? "upstream/main");
    console.log(JSON.stringify(result, null, 2));
    if (result.candidates.length) process.exitCode = 2;
  } catch (error) {
    console.error(`Cannot inspect upstream localization: ${error.message}`);
    process.exitCode = 1;
  }
}
