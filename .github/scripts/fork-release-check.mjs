import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  assertWorkflowSnapshot,
  releaseComplete,
  validateBuildDescriptor,
} from "./fork-maintenance.mjs";

export async function checkPreparedRelease({
  descriptor,
  build,
  config,
  repository,
  head,
  workflow,
  run,
  request,
  rebuild = false,
}) {
  const expected = validateBuildDescriptor(descriptor);
  if (
    repository !== config.repository ||
    head !== expected.ref ||
    build.upstream !== config.upstream ||
    build.upstreamTag !== expected.upstream_tag ||
    build.channel !== expected.channel ||
    expected.tag !== `${build.upstreamTag}-zh.${build.fingerprint}` ||
    ![build.upstreamSha, build.forkSha].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? ""))
  )
    throw new Error("Prepared source does not match release identity");
  assertWorkflowSnapshot({ run, source: head, workflow });
  const root = `repos/${config.repository}`;
  if ((await request(root)).id !== config.repositoryId)
    throw new Error("Repository identity changed");
  const release = await request(`${root}/releases/tags/${encodeURIComponent(expected.tag)}`, {
    allowMissing: true,
  });
  if (!release) return true;
  if (
    release.tag_name !== expected.tag ||
    Boolean(release.prerelease) !== (expected.channel === "nightly")
  )
    throw new Error("Existing release identity differs from prepared source");
  const tag = await request(`${root}/git/ref/tags/${encodeURIComponent(expected.tag)}`, {
    allowMissing: true,
  });
  if (!tag && release.draft) return true;
  let object = tag?.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++)
    object = (await request(`${root}/git/tags/${object.sha}`)).object;
  if (object?.type !== "commit" || object.sha !== expected.ref)
    throw new Error("Existing release tag identity differs from prepared source");
  const required = ["SHA256SUMS", "build-provenance.json", "macos-signing.json"];
  const assets = release.assets ?? [];
  if (!releaseComplete(release)) return true;
  if (
    !assets.some((asset) => /-arm64\.zip$/.test(asset.name)) ||
    !required.every((name) => assets.some((asset) => asset.name === name && asset.size > 0))
  )
    throw new Error("Published release has incomplete verification metadata");
  const asset = assets.find((item) => item.name === "build-provenance.json");
  if (!Number.isSafeInteger(asset.id)) throw new Error("Invalid provenance asset identity");
  const provenance = await request(`${root}/releases/assets/${asset.id}`, {
    headers: { Accept: "application/octet-stream" },
  });
  if (
    provenance.sourceCommit !== expected.ref ||
    provenance.appUpdatesEnabled !== false ||
    JSON.stringify(provenance.targets) !== JSON.stringify(config.desktopTargets) ||
    ["upstream", "upstreamTag", "upstreamSha", "forkSha", "fingerprint", "channel"].some(
      (key) => provenance[key] !== build[key],
    )
  )
    throw new Error("Existing release provenance differs from prepared source");
  return rebuild;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const env = process.env;
  const run = (args) => NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
  const request = async (path, options = {}) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404 && options.allowMissing) return null;
    if (!response.ok) throw new Error(`GitHub GET ${path}: ${response.status}`);
    return response.json();
  };
  const buildNeeded = await checkPreparedRelease({
    descriptor: {
      ref: env.SOURCE_REF,
      version: env.VERSION,
      tag: env.RELEASE_TAG,
      channel: env.CHANNEL,
      upstream_tag: env.UPSTREAM_TAG,
      artifact_namespace: env.ARTIFACT_NAMESPACE,
    },
    build: JSON.parse(NodeFS.readFileSync(".fork/build.json", "utf8")),
    config: JSON.parse(NodeFS.readFileSync(".fork/config.json", "utf8")),
    repository: env.GITHUB_REPOSITORY,
    head: run(["rev-parse", "HEAD"]),
    workflow: env.WORKFLOW_SHA,
    run,
    request,
    rebuild: env.REBUILD === "true",
  });
  if (env.GITHUB_OUTPUT) NodeFS.appendFileSync(env.GITHUB_OUTPUT, `build_needed=${buildNeeded}\n`);
  console.log(
    buildNeeded
      ? "Prepared source requires verified desktop builds."
      : "Exact source already has a complete published release; skipping builds.",
  );
}
