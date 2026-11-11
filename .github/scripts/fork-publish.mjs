import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import { releaseChannel, releaseComplete } from "./fork-maintenance.mjs";

const e = process.env;
const build = JSON.parse(await NodeFSP.readFile(".fork/build.json", "utf8"));
const config = JSON.parse(await NodeFSP.readFile(".fork/config.json", "utf8"));
const gh = (args) =>
  NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
if (
  e.GITHUB_REPOSITORY !== config.repository ||
  !/^[a-f0-9]{40}$/.test(e.SOURCE_REF) ||
  releaseChannel(e.UPSTREAM_TAG) !== e.CHANNEL ||
  build.upstreamTag !== e.UPSTREAM_TAG ||
  e.RELEASE_TAG !== `${e.UPSTREAM_TAG}-zh.${build.fingerprint}`
)
  throw new Error("Invalid release identity.");
const repository = JSON.parse(gh(["api", `repos/${config.repository}`]));
if (repository.id !== config.repositoryId) throw new Error("Repository identity changed.");
const files = (await NodeFSP.readdir("release-publish"))
  .filter((name) => /(?:-arm64\.(?:dmg|zip)|-x64\.exe)$/.test(name))
  .sort();
if (!files.some((f) => f.endsWith("-arm64.dmg")) || !files.some((f) => f.endsWith("-x64.exe")))
  throw new Error("Both macOS ARM64 and Windows x64 installers are required before publishing.");
const sums = [];
for (const name of files) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(`release-publish/${name}`)) hash.update(chunk);
  sums.push(`${hash.digest("hex")}  ${name}`);
}
await NodeFSP.writeFile("release-publish/SHA256SUMS", `${sums.join("\n")}\n`);
await NodeFSP.writeFile(
  "release-publish/build-provenance.json",
  `${JSON.stringify({ ...build, sourceCommit: e.SOURCE_REF, workflowRun: `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`, targets: config.desktopTargets, signed: false, appUpdatesEnabled: false }, null, 2)}\n`,
);
const notes = `基于 [${e.UPSTREAM_TAG}](https://github.com/${config.upstream}/releases/tag/${e.UPSTREAM_TAG}) 的简体中文维护版本。\n\n- 仅发布 macOS ARM64 与 Windows x64 安装包。\n- 已禁用 T3 Code 自身的版本检查、自动下载和自动安装；请手动下载新包。\n- 简体中文来自 deepfry666/t3code-cn 的本地化补丁，并持续补齐。\n- Windows 包含从本仓库相同源码构建的 WSL 运行组件，不另行发布 Linux 桌面版本。\n- 安装包未签名/未公证，首次安装可能出现系统安全提示；没有使用或申请你的签名凭据。\n- 两个平台打包与验证通过后才发布。SHA256SUMS 和 build-provenance.json 记录校验值与精确源码。\n\n上游源码：${build.upstreamSha}\n维护源码：${e.SOURCE_REF}\n`;
await NodeFSP.writeFile("release-publish/RELEASE_NOTES.md", notes);
let existing;
try {
  existing = JSON.parse(
    gh(["api", `repos/${config.repository}/releases/tags/${encodeURIComponent(e.RELEASE_TAG)}`]),
  );
} catch (error) {
  if (!String(error.stderr ?? "").includes("404")) throw error;
}
let tag;
try {
  tag = JSON.parse(
    gh(["api", `repos/${config.repository}/git/ref/tags/${encodeURIComponent(e.RELEASE_TAG)}`]),
  );
} catch (error) {
  if (!String(error.stderr ?? "").includes("404")) throw error;
}
if (tag) {
  let object = tag.object;
  while (object.type === "tag")
    object = JSON.parse(gh(["api", `repos/${config.repository}/git/tags/${object.sha}`])).object;
  if (object.sha !== e.SOURCE_REF)
    throw new Error("Existing release tag points to different source; refusing to overwrite it.");
}
if (existing && releaseComplete(existing)) {
  console.log(
    "This source already has a complete published release. Keeping its original artifacts.",
  );
  process.exit(0);
}
if (existing) {
  if (!existing.draft)
    gh(["release", "edit", e.RELEASE_TAG, "--repo", config.repository, "--draft"]);
} else {
  gh([
    "release",
    "create",
    e.RELEASE_TAG,
    "--repo",
    config.repository,
    "--target",
    e.SOURCE_REF,
    "--draft",
    "--title",
    `T3 Code ${e.UPSTREAM_TAG} 简体中文 (${e.CHANNEL})`,
    "--notes-file",
    "release-publish/RELEASE_NOTES.md",
    ...(e.CHANNEL === "nightly" ? ["--prerelease"] : []),
  ]);
}
gh([
  "release",
  "upload",
  e.RELEASE_TAG,
  "--repo",
  config.repository,
  "--clobber",
  ...[...files, "SHA256SUMS", "build-provenance.json"].map((name) => `release-publish/${name}`),
]);
const latestUpstream = JSON.parse(gh(["api", `repos/${config.upstream}/releases/latest`]));
const makeLatest = e.CHANNEL === "stable" && latestUpstream.tag_name === e.UPSTREAM_TAG;
gh([
  "release",
  "edit",
  e.RELEASE_TAG,
  "--repo",
  config.repository,
  "--draft=false",
  `--prerelease=${e.CHANNEL === "nightly"}`,
  `--latest=${makeLatest}`,
  "--notes-file",
  "release-publish/RELEASE_NOTES.md",
]);
console.log(`Published https://github.com/${config.repository}/releases/tag/${e.RELEASE_TAG}`);
