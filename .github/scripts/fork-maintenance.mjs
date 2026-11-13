import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(NodeFS.readFileSync(NodePath.resolve(root, ".fork/config.json"), "utf8"));
export function gitOutput(args, output) {
  return args[0] === "diff" && args.includes("--binary") ? output : output.trim();
}
const git = (args, options = {}) =>
  gitOutput(
    args,
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    }),
  );
const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

export function releaseChannel(tag) {
  if (/^v\d+\.\d+\.\d+$/.test(tag)) return "stable";
  if (/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) return "nightly";
  return null;
}

export function selectReleases(releases) {
  const sorted = releases
    .filter((r) => !r.draft)
    .toSorted((a, b) => b.published_at.localeCompare(a.published_at));
  return ["stable", "nightly"].flatMap((channel) => {
    const release = sorted.find(
      (r) => releaseChannel(r.tag_name) === channel && (channel === "nightly" || !r.prerelease),
    );
    return release ? [{ ...release, channel }] : [];
  });
}

export function releaseComplete(release) {
  return Boolean(
    !release.draft &&
    release.assets?.some((a) => /-arm64\.dmg$/.test(a.name)) &&
    release.assets?.some((a) => /-x64\.exe$/.test(a.name)),
  );
}

// Normalize against the current upstream only to compute a fork-only delta.
// The synthetic tree must never become the tagged release source.
export function normalizedOverlayBase({ run, baseline, auditedFork, upstream, fork }) {
  if (![baseline, auditedFork, upstream, fork].every((ref) => /^[0-9a-f]{40}$/.test(ref)))
    throw new Error("Invalid normalized overlay commit");
  for (const [ancestor, descendant] of [
    [auditedFork, fork],
    [baseline, auditedFork],
    [baseline, upstream],
    [upstream, fork],
  ]) {
    run(["merge-base", "--is-ancestor", ancestor, descendant]);
  }
  const tree = run([
    "merge-tree",
    "--write-tree",
    `--merge-base=${baseline}`,
    auditedFork,
    upstream,
  ]).trim();
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error("Invalid normalized overlay tree");
  return tree;
}

export function forkOverlayDiff(run, from, to) {
  return run([
    "diff",
    "--binary",
    "--full-index",
    from,
    to,
    "--",
    ".",
    ":(exclude).fork/upstream.json",
    ":(exclude).fork/release-sources.json",
    ":(exclude).github/workflows",
    ":(exclude).github/upstream-workflows",
  ]);
}

export function releaseDelta(run, from, to) {
  const patch = forkOverlayDiff(run, from, to);
  const workflowDelta = run(["diff", "--full-index", from, to, "--", ".github/workflows"]);
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(patch)
    .update(workflowDelta)
    .digest("hex")
    .slice(0, 12);
  return { patch, workflowDelta, fingerprint };
}

export function auditedOverlay({
  override,
  fingerprint,
  upstream,
  readBaseline,
  isAncestor,
  normalize,
  diff,
}) {
  if (!override) return null;
  if (override.fingerprint === fingerprint) return { source: override.sourceCommit, patch: "" };
  if (!/^[0-9a-f]{40}$/.test(override.forkCommit ?? "")) return null;
  if (!isAncestor(override.forkCommit))
    throw new Error("Audited fork is not a current fork ancestor");
  const baseline = readBaseline(override.forkCommit);
  const base =
    baseline === upstream ? override.forkCommit : normalize(baseline, override.forkCommit);
  return { source: override.sourceCommit, patch: diff(base) };
}

// Build an immutable content-only source commit without introducing new
// executable workflow definitions or previously unmerged upstream history.
export function commitPreparedSource({ worktree, fork, source, message }) {
  const run = (args) => git(args, { cwd: worktree });
  run(["merge-base", "--is-ancestor", source, fork]);
  run(["restore", "--source", fork, "--staged", "--worktree", ".github/workflows"]);
  run(["add", "-A"]);
  const tree = run(["write-tree"]);
  if (
    run(["rev-parse", `${tree}:.github/workflows`]) !==
    run(["rev-parse", `${fork}:.github/workflows`])
  )
    throw new Error("Prepared source would alter executable workflow definitions.");
  return run(["commit-tree", tree, "-p", fork, "-p", source, "-m", message]);
}

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok)
    throw new Error(
      `GitHub ${options.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
    );
  return response.status === 204 ? null : response.json();
}

async function verifyRepository(request = api, repositoryName = process.env.GITHUB_REPOSITORY) {
  if (repositoryName !== config.repository)
    throw new Error("Maintenance is restricted to the configured fork.");
  const repository = await request(`repos/${config.repository}`);
  if (repository.id !== config.repositoryId)
    throw new Error("Repository identity changed. Refusing to modify a recreated repository.");
}

export function validateBuildDescriptor(build) {
  if (
    !build || !/^[0-9a-f]{40}$/.test(build.ref ?? "") ||
    releaseChannel(build.upstream_tag) !== build.channel ||
    !["stable", "nightly"].includes(build.channel) ||
    build.version !== build.upstream_tag?.slice(1) ||
    !/^[0-9a-f]{12}$/.test(build.tag?.slice(`${build.upstream_tag}-zh.`.length) ?? "") ||
    !build.tag.startsWith(`${build.upstream_tag}-zh.`)
  ) throw new Error("Invalid immutable release build descriptor");
  const artifact_namespace = `${build.channel}-${build.ref}-`;
  if (build.artifact_namespace !== undefined && build.artifact_namespace !== artifact_namespace)
    throw new Error("Invalid release artifact namespace");
  return {
    ref: build.ref, version: build.version, tag: build.tag, channel: build.channel,
    upstream_tag: build.upstream_tag, artifact_namespace,
  };
}

export function buildOutputs(builds) {
  if (!Array.isArray(builds)) throw new Error("Build descriptors must be an array");
  const validated = builds.map(validateBuildDescriptor);
  if (new Set(validated.map((build) => build.channel)).size !== validated.length)
    throw new Error("Duplicate release channel");
  return { builds: JSON.stringify(validated), has_builds: String(validated.length > 0) };
}

export function assertWorkflowSnapshot({ run, source, workflow }) {
  if (![source, workflow].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? "")))
    throw new Error("Source and workflow must be immutable commits");
  const sourceTree = run(["rev-parse", `${source}:.github/workflows`]);
  const workflowTree = run(["rev-parse", `${workflow}:.github/workflows`]);
  if (!/^[0-9a-f]{40}$/.test(sourceTree) || sourceTree !== workflowTree)
    throw new Error("Prepared source workflow snapshot differs from the executing workflow");
}

// Upstream's workflows require its private runners and signing/deployment keys.
// Keep them for reference, but only the fork's workflow set can execute here.
function archiveUpstreamWorkflows(original) {
  NodeFS.mkdirSync(NodePath.resolve(root, ".github/upstream-workflows"), { recursive: true });
  for (const name of NodeFS.readdirSync(NodePath.resolve(root, ".github/workflows"))) {
    if (["fork-maintenance.yml", "fork-desktop.yml", "fork-release.yml", "fork-watchdog.yml"].includes(name)) continue;
    NodeFS.renameSync(
      NodePath.resolve(root, ".github/workflows", name),
      NodePath.resolve(root, ".github/upstream-workflows", name),
    );
  }
  // Scheduled runs do not change executable workflow definitions. Keep new
  // upstream definitions in the archive for a validated maintenance change.
  git(["restore", "--source", original, "--staged", "--worktree", ".github/workflows"]);
}

async function sync() {
  await verifyRepository();
  if (git(["status", "--porcelain"])) throw new Error("Sync requires a clean checkout.");
  const original = git(["rev-parse", "HEAD"]);
  output("original", original);
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  if (!git(["remote"]).split("\n").includes("upstream"))
    git(["remote", "add", "upstream", `https://github.com/${config.upstream}.git`]);
  // A fork fix must validate its reviewed snapshot, not race new upstream work.
  // Scheduled and manual maintenance still fetch and merge the latest upstream.
  if (process.env.GITHUB_EVENT_NAME === "push") {
    console.log("Push validation keeps the current upstream baseline.");
    return;
  }
  git([
    "fetch",
    "--filter=blob:none",
    "--no-tags",
    "upstream",
    "+refs/heads/main:refs/remotes/upstream/main",
  ]);
  const upstream = git(["rev-parse", "upstream/main"]);
  // Native upstream localization must be adopted deliberately, never hidden by
  // the fork's translation runtime. Exit 2 leaves main unchanged for repair.
  NodeChildProcess.execFileSync(process.execPath, ["scripts/i18n-upstream.mjs", "upstream/main"], {
    cwd: root,
    stdio: "inherit",
  });
  let conflict = false;
  try {
    git(["merge", "--no-commit", "--no-ff", "upstream/main"]);
  } catch {
    conflict = true;
  }
  if (conflict) {
    const unresolved = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    // Only workflow archival is a mechanical conflict. Never silently choose
    // ours/theirs for source, translations, package versions or a lockfile.
    for (const file of unresolved.filter(
      (p) => p.startsWith(".github/workflows/") && !p.split("/").at(-1).startsWith("fork-"),
    )) {
      if (file.endsWith("/release-desktop.yml")) {
        git(["checkout", "--theirs", "--", file]);
        git(["add", "--", file]);
      } else {
        const contents = git(["show", `upstream/main:${file}`]);
        const archived = file.replace(".github/workflows/", ".github/upstream-workflows/");
        NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(root, archived)), { recursive: true });
        NodeFS.writeFileSync(NodePath.resolve(root, archived), `${contents}\n`);
        git(["rm", "-f", "--", file]);
        git(["add", "--", archived]);
      }
    }
    const remaining = git(["diff", "--name-only", "--diff-filter=U"]);
    if (remaining) {
      NodeFS.writeFileSync(
        NodePath.resolve(root, "fork-maintenance-report.json"),
        JSON.stringify({ status: "conflict", upstream, files: remaining.split("\n") }, null, 2),
      );
      git(["merge", "--abort"]);
      throw new Error(
        `Source conflicts require semantic repair; origin is unchanged:\n${remaining}`,
      );
    }
  }
  archiveUpstreamWorkflows(original);
  NodeFS.writeFileSync(
    NodePath.resolve(root, ".fork/upstream.json"),
    `${JSON.stringify({ sha: upstream }, null, 2)}\n`,
  );
  git(["add", ".github", ".fork/upstream.json"]);
  if (git(["status", "--porcelain"]))
    git(["commit", "-m", `chore(fork): synchronize upstream ${upstream.slice(0, 12)}`]);
}

async function prepare() {
  for (const [name, value] of Object.entries(buildOutputs([]))) output(name, value);
  await verifyRepository();
  if (git(["status", "--porcelain"])) {
    git(["add", "-A"]);
    git(["commit", "-m", "chore(fork): refresh validated dependencies and translations"]);
  }
  // A regular push rejects concurrent user changes; no reset or force-push.
  git(["push", "origin", `HEAD:refs/heads/${config.branch}`]);
  const fork = git(["rev-parse", "HEAD"]);
  const state = JSON.parse(
    NodeFS.readFileSync(NodePath.resolve(root, ".fork/upstream.json"), "utf8"),
  );
  const { patch, fingerprint } = releaseDelta(git, state.sha, fork);
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const next = await api(`repos/${config.upstream}/releases?per_page=100&page=${page}`);
    releases.push(...next);
    if (selectReleases(releases).length === 2 || next.length < 100) break;
  }
  const selected = selectReleases(releases);
  if (selected.length !== 2)
    throw new Error(
      "Could not NodePath.resolve both published upstream stable and nightly releases.",
    );
  const overridePath = NodePath.resolve(root, ".fork/release-sources.json");
  const overrides = NodeFS.existsSync(overridePath)
    ? JSON.parse(NodeFS.readFileSync(overridePath, "utf8"))
    : {};
  const builds = [];
  const failures = [];
  for (const release of selected) {
    try {
      const tag = `${release.tag_name}-zh.${fingerprint}`;
      git(["fetch", "--no-tags", "upstream", `refs/tags/${release.tag_name}`]);
      const source = git(["rev-parse", "FETCH_HEAD^{commit}"]);
      const branch = `fork-build/${release.tag_name}-${fingerprint}`;
      const remote = git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).split(/\s/)[0];
      if (remote) {
        git(["fetch", "--no-tags", "origin", branch]);
        const previous = JSON.parse(git(["show", `${remote}:.fork/build.json`]));
        if (
          previous.upstreamSha !== source ||
          previous.fingerprint !== fingerprint ||
          previous.upstreamTag !== release.tag_name ||
          previous.channel !== release.channel
        )
          throw new Error(`Existing build branch has different provenance: ${branch}`);
        builds.push(validateBuildDescriptor({
          ref: remote,
          version: release.tag_name.slice(1),
          tag,
          channel: release.channel,
          upstream_tag: release.tag_name,
        }));
        continue;
      }
      const audited = auditedOverlay({
        override: overrides[source],
        fingerprint,
        upstream: state.sha,
        readBaseline: (ref) => JSON.parse(git(["show", `${ref}:.fork/upstream.json`])).sha,
        isAncestor: (ref) => {
          try {
            git(["merge-base", "--is-ancestor", ref, fork]);
            return true;
          } catch {
            return false;
          }
        },
        normalize: (baseline, auditedFork) =>
          normalizedOverlayBase({ run: git, baseline, auditedFork, upstream: state.sha, fork }),
        diff: (ref) => forkOverlayDiff(git, ref, fork),
      });
      if (audited) {
        if (!/^[0-9a-f]{40}$/.test(audited.source))
          throw new Error("Invalid audited release source commit");
        git(["fetch", "--no-tags", "origin", audited.source]);
        git(["merge-base", "--is-ancestor", source, audited.source]);
      }
      const worktree = NodePath.resolve(root, `../fork-source-${release.channel}`);
      git(["worktree", "add", "--detach", worktree, audited ? audited.source : source]);
      try {
        // --3way reports conflicts instead of replacing newer upstream logic.
        const releasePatch = audited ? audited.patch : patch;
        if (releasePatch)
          git(["apply", "--3way", "--whitespace=nowarn", "-"], {
            cwd: worktree,
            input: `${releasePatch}\n`,
          });
        NodeFS.writeFileSync(
          NodePath.resolve(worktree, ".fork/build.json"),
          `${JSON.stringify({ upstream: config.upstream, upstreamTag: release.tag_name, upstreamSha: source, auditedSourceSha: audited?.source ?? null, forkSha: fork, fingerprint, channel: release.channel }, null, 2)}\n`,
        );
        const publishedMain = git([
          "ls-remote",
          "--heads",
          "origin",
          `refs/heads/${config.branch}`,
        ]).split(/\s/)[0];
        if (publishedMain !== fork)
          throw new Error("Main changed during preparation; retry against the latest source.");
        const commit = commitPreparedSource({
          worktree,
          fork,
          source,
          message: `build(fork): prepare ${release.tag_name} with Chinese localization`,
        });
        git(["push", "origin", `${commit}:refs/heads/${branch}`]);
        builds.push(validateBuildDescriptor({
          ref: commit,
          version: release.tag_name.slice(1),
          tag,
          channel: release.channel,
          upstream_tag: release.tag_name,
        }));
      } finally {
        git(["worktree", "remove", "--force", worktree]);
      }
    } catch (error) {
      failures.push({ channel: release.channel, tag: release.tag_name, error: String(error) });
    }
  }
  NodeFS.writeFileSync(
    NodePath.resolve(root, "fork-maintenance-report.json"),
    JSON.stringify(
      {
        status: failures.length ? "partial-failure" : "prepared",
        fork,
        upstream: state.sha,
        builds,
        failures,
      },
      null,
      2,
    ),
  );
  for (const [name, value] of Object.entries(buildOutputs(builds))) output(name, value);
  console.log(`Prepared ${builds.length} release build(s) for the maintenance graph.`);
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => new Error(JSON.stringify(failure))),
      "Some release channels need repair; unaffected builds are available to the release graph.",
    );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const action = process.argv[2];
  if (action === "sync") await sync();
  else if (action === "prepare") await prepare();
  else throw new Error("Usage: node .github/scripts/fork-maintenance.mjs <sync|prepare>");
}

