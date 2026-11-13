import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  releaseChannel,
  selectReleases,
  releaseComplete,
  auditedOverlay,
  normalizedOverlayBase,
  forkOverlayDiff,
  releaseDelta,
  commitPreparedSource,
  gitOutput,
  buildOutputs,
  validateBuildDescriptor,
  assertWorkflowSnapshot,
} from "./fork-maintenance.mjs";

const stableBuild = () => ({
  ref: "a".repeat(40), version: "0.1.9", tag: "v0.1.9-zh.0123456789ab",
  channel: "stable", upstream_tag: "v0.1.9",
});

NodeTest.test("empty preparation safely skips every release", () => {
  NodeAssert.deepEqual(buildOutputs([]), { builds: "[]", has_builds: "false" });
});

NodeTest.test("partial preparation emits only validated successful channels", () => {
  const build = stableBuild();
  NodeAssert.deepEqual(buildOutputs([build]), {
    builds: JSON.stringify([{ ...build, artifact_namespace: `stable-${build.ref}-` }]),
    has_builds: "true",
  });
});

NodeTest.test("build descriptors reject malformed identities and duplicate channels", () => {
  for (const mutation of [
    { ref: "main" }, { version: "0.1.8" }, { tag: "v0.1.9-zh.no" },
    { channel: "nightly" }, { upstream_tag: "v0.1.9-rc.1" },
    { ref: "a".repeat(40) + "\\nfoo=true" }, { artifact_namespace: "other-" },
  ]) NodeAssert.throws(() => validateBuildDescriptor({ ...stableBuild(), ...mutation }));
  NodeAssert.throws(() => buildOutputs([stableBuild(), stableBuild()]));
  NodeAssert.throws(() => buildOutputs(null));
});

NodeTest.test("workflow snapshot equality is mandatory for immutable sources", () => {
  const calls = [];
  const source = "a".repeat(40), workflow = "b".repeat(40), tree = "c".repeat(40);
  const run = (args) => { calls.push(args); return tree; };
  assertWorkflowSnapshot({ run, source, workflow });
  NodeAssert.deepEqual(calls, [
    ["rev-parse", `${source}:.github/workflows`],
    ["rev-parse", `${workflow}:.github/workflows`],
  ]);
  NodeAssert.throws(() => assertWorkflowSnapshot({ run: ([, ref]) => ref.startsWith(source) ? tree : "d".repeat(40), source, workflow }), /workflow snapshot/i);
  NodeAssert.throws(() => assertWorkflowSnapshot({ run, source: "main", workflow }), /immutable/i);
});

NodeTest.test("binary diffs retain blank context lines so release patches remain valid", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-patch-context-"));
  const execute = (args, options = {}) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
  try {
    execute(["init", "--initial-branch=main"]);
    execute(["config", "user.name", "Test"]);
    execute(["config", "user.email", "test@example.invalid"]);
    execute(["config", "commit.gpgSign", "false"]);
    const file = NodePath.join(directory, "config.txt");
    NodeFS.writeFileSync(file, "old value\n\n");
    execute(["add", "config.txt"]);
    execute(["commit", "-m", "baseline"]);
    NodeFS.writeFileSync(file, "new value\n\n");
    const args = ["diff", "--binary", "HEAD"];
    const patch = gitOutput(args, execute(args));
    execute(["restore", "config.txt"]);
    execute(["apply", "--3way", "-"], { input: `${patch}\n` });
    NodeAssert.equal(NodeFS.readFileSync(file, "utf8"), "new value\n\n");
    NodeAssert.equal(gitOutput(["rev-parse", "HEAD"], "abc\n"), "abc");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

NodeTest.test("release diffs and fingerprints ignore core.abbrev", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fingerprint-"));
  const run = (args, options = {}) =>
    gitOutput(
      args,
      NodeChildProcess.execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        ...options,
      }),
    );
  try {
    run(["init", "--initial-branch=main"]);
    run(["config", "user.name", "Test"]);
    run(["config", "user.email", "test@example.invalid"]);
    run(["config", "commit.gpgSign", "false"]);
    NodeFS.mkdirSync(NodePath.join(directory, ".github/workflows"), { recursive: true });
    const source = NodePath.join(directory, "source.txt");
    const workflow = NodePath.join(directory, ".github/workflows/build.yml");
    const binary = NodePath.join(directory, "asset.bin");
    NodeFS.writeFileSync(source, "old value\n\n");
    NodeFS.writeFileSync(workflow, "name: old workflow\n");
    NodeFS.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
    run(["add", "-A"]);
    run(["commit", "-m", "baseline"]);
    const baseline = run(["rev-parse", "HEAD"]);
    NodeFS.writeFileSync(source, "new value\n\n");
    NodeFS.writeFileSync(workflow, "name: new workflow\n");
    NodeFS.writeFileSync(binary, Buffer.from([0, 4, 5, 6]));
    run(["add", "-A"]);
    run(["commit", "-m", "fork changes"]);
    const fork = run(["rev-parse", "HEAD"]);
    run(["config", "core.abbrev", "7"]);
    const short = releaseDelta(run, baseline, fork);
    run(["config", "core.abbrev", "12"]);
    const long = releaseDelta(run, baseline, fork);
    NodeAssert.deepEqual(short, long);
    NodeAssert.equal(forkOverlayDiff(run, baseline, fork), short.patch);
    NodeAssert.match(short.patch, /GIT binary patch/);
    NodeAssert.match(short.patch, / \n$/);
    NodeAssert.doesNotMatch(short.patch, /build.yml/);
    NodeAssert.match(short.workflowDelta, /build.yml/);
    run(["checkout", "--detach", baseline]);
    run(["apply", "--3way", "-"], { input: short.patch });
    NodeAssert.equal(NodeFS.readFileSync(source, "utf8"), "new value\n\n");
    NodeAssert.deepEqual(NodeFS.readFileSync(binary), Buffer.from([0, 4, 5, 6]));
    NodeAssert.equal(NodeFS.readFileSync(workflow, "utf8"), "name: old workflow\n");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

NodeTest.test("only stable and official nightly tags are admitted", () => {
  NodeAssert.equal(releaseChannel("v0.1.9"), "stable");
  NodeAssert.equal(releaseChannel("v0.1.9-nightly.20261111.4515"), "nightly");
  for (const tag of [
    "v0.1.9-preview.20261111.4511",
    "v0.1.9-zh.1",
    "$(touch BAD)",
    "--help",
    "v1.2.3/../../main",
  ])
    NodeAssert.equal(releaseChannel(tag), null);
});
NodeTest.test("publication dates select each channel without treating previews as nightly", () => {
  const data = [
    { tag_name: "v0.1.8", published_at: "2026-11-10", prerelease: false },
    { tag_name: "v0.1.9", published_at: "2026-11-11", prerelease: false },
    { tag_name: "v0.2.0", published_at: "2026-11-12", draft: true },
    { tag_name: "v0.1.9-nightly.20261111.4515", published_at: "2026-11-11", prerelease: true },
    { tag_name: "v0.1.9-preview.20261112.4516", published_at: "2026-11-12", prerelease: true },
  ];
  NodeAssert.deepEqual(
    selectReleases(data).map((r) => r.tag_name),
    ["v0.1.9", "v0.1.9-nightly.20261111.4515"],
  );
});
NodeTest.test("partial and draft releases are retried", () => {
  const assets = [{ name: "T3-Code-0.1.9-arm64.dmg" }, { name: "T3-Code-0.1.9-x64.exe" }];
  NodeAssert.equal(releaseComplete({ draft: false, assets }), true);
  NodeAssert.equal(releaseComplete({ draft: true, assets }), false);
  NodeAssert.equal(releaseComplete({ draft: false, assets: assets.slice(0, 1) }), false);
});

NodeTest.test(
  "audited release sources accept fork-only changes but never newer upstream features",
  () => {
    const commit = "1".repeat(40);
    const override = { sourceCommit: "2".repeat(40), fingerprint: "old", forkCommit: commit };
    const args = {
      override,
      fingerprint: "new",
      upstream: "tag-baseline",
      readBaseline: () => "tag-baseline",
      isAncestor: () => true,
      diff: (ref) => `fork-only changes since ${ref}`,
    };
    NodeAssert.deepEqual(auditedOverlay(args), {
      source: override.sourceCommit,
      patch: `fork-only changes since ${commit}`,
    });
    NodeAssert.deepEqual(
      auditedOverlay({
        ...args,
        readBaseline: () => "different-upstream",
        normalize: () => "normalized-tree",
      }),
      { source: override.sourceCommit, patch: "fork-only changes since normalized-tree" },
    );
    NodeAssert.throws(() => auditedOverlay({ ...args, isAncestor: () => false }), /ancestor/);
    NodeAssert.deepEqual(
      auditedOverlay({
        ...args,
        fingerprint: "old",
        diff: () => {
          throw new Error("exact audited source needs no replay");
        },
      }),
      { source: override.sourceCommit, patch: "" },
    );
  },
);

NodeTest.test(
  "prepared commits preserve tagged app code while inheriting the exact fork workflow tree",
  () => {
    const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-prepared-source-"));
    const git = (...args) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: worktree,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      }).trim();
    const write = (path, content) => {
      const target = NodePath.join(worktree, path);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, content);
    };
    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "Fork maintenance test");
      git("config", "user.email", "fork-test@example.invalid");
      git("config", "commit.gpgSign", "false");
      write("app.txt", "exact upstream release\n");
      write(".github/workflows/upstream-only.yml", "name: Old upstream workflow\n");
      write(".github/workflows/shared.yml", "name: Original shared workflow\n");
      git("add", "-A");
      git("commit", "-m", "upstream release");
      const source = git("rev-parse", "HEAD");
      git("tag", "v1.0.0");

      write("app.txt", "newer main feature must not leak into the release\n");
      NodeFS.rmSync(NodePath.join(worktree, ".github/workflows/upstream-only.yml"));
      write(".github/workflows/shared.yml", "name: Fork shared workflow\n");
      write(".github/workflows/fork-desktop.yml", "name: Approved fork build\n");
      git("add", "-A");
      git("commit", "-m", "fork main with approved workflows");
      const fork = git("rev-parse", "HEAD");

      git("checkout", "--detach", source);
      write("app.txt", "exact upstream release with Chinese patch\n");
      write("locales/zh-CN.json", '{"hello":"你好"}\n');
      const commit = commitPreparedSource({
        worktree,
        fork,
        source,
        message: "prepare localized release",
      });

      NodeAssert.equal(
        git("show", `${commit}:app.txt`),
        "exact upstream release with Chinese patch",
      );
      NodeAssert.equal(git("show", `${commit}:locales/zh-CN.json`), '{"hello":"你好"}');
      NodeAssert.equal(
        git("rev-parse", `${commit}:.github/workflows`),
        git("rev-parse", `${fork}:.github/workflows`),
      );
      NodeAssert.equal(git("show", "-s", "--format=%P", commit), `${fork} ${source}`);
      NodeAssert.equal(git("rev-parse", "main"), fork);
      NodeAssert.equal(git("rev-parse", "v1.0.0"), source);
    } finally {
      NodeFS.rmSync(worktree, { recursive: true, force: true });
    }
  },
);

for (const scenario of [
  "clean",
  "normalization-conflict",
  "apply-conflict",
  "unrelated-baseline",
  "unrelated-fork",
]) {
  NodeTest.test(`normalized audited overlay: ${scenario}`, () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "fork-normalized-overlay-"),
    );
    const run = (args, options = {}) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
        ...options,
      }).trim();
    const write = (path, value) => {
      const target = NodePath.join(directory, path);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, value);
    };
    const commit = (message) => {
      run(["add", "-A"]);
      run(["commit", "-m", message]);
      return run(["rev-parse", "HEAD"]);
    };
    try {
      run(["init", "--initial-branch=upstream"]);
      run(["config", "user.name", "Overlay test"]);
      run(["config", "user.email", "overlay@example.invalid"]);
      run(["config", "commit.gpgSign", "false"]);
      write("app.txt", "tagged application\n");
      const baseline = commit("upstream baseline");
      run(["checkout", "-b", "fork"]);
      write("fork.txt", "old fork fix\n");
      write(".fork/upstream.json", JSON.stringify({ sha: baseline }));
      if (scenario === "normalization-conflict") write("app.txt", "localized application\n");
      const auditedFork = commit("audited fork");
      run(["checkout", "upstream"]);
      write("runtime-feature.txt", "new upstream runtime feature MUST NOT enter the old tag\n");
      if (scenario === "normalization-conflict") write("app.txt", "new upstream application\n");
      const upstream = commit("new upstream runtime feature");
      run(["checkout", "fork"]);
      if (scenario === "normalization-conflict") {
        NodeAssert.throws(() => run(["merge", "--no-edit", upstream]));
        write("app.txt", "explicit human integration resolution\n");
        commit("human resolves overlapping upstream and fork edits");
      } else run(["merge", "--no-edit", upstream]);
      write("fork.txt", "new fork fix\n");
      write(".fork/upstream.json", JSON.stringify({ sha: upstream }));
      write(".fork/release-sources.json", "{}\n");
      write(".github/workflows/build.yml", "name: current workflow\n");
      write(".github/upstream-workflows/ci.yml", "name: mirrored upstream workflow\n");
      const fork = commit("new fork-only fix and maintenance metadata");
      run(["checkout", "--detach", baseline]);
      write(
        "fork.txt",
        scenario === "apply-conflict" ? "audited stable-specific correction\n" : "old fork fix\n",
      );
      const source = commit("audited stable release source");
      const args = {
        override: { sourceCommit: source, forkCommit: auditedFork, fingerprint: "old" },
        fingerprint: "new",
        upstream,
        readBaseline: () => (scenario === "unrelated-baseline" ? source : baseline),
        isAncestor: (ref) => {
          try {
            run([
              "merge-base",
              "--is-ancestor",
              ref,
              scenario === "unrelated-fork" ? source : fork,
            ]);
            return true;
          } catch {
            return false;
          }
        },
        normalize: (oldUpstream, oldFork) =>
          normalizedOverlayBase({
            run,
            baseline: oldUpstream,
            auditedFork: oldFork,
            upstream,
            fork,
          }),
        diff: (from) => forkOverlayDiff(run, from, fork),
      };
      if (["normalization-conflict", "unrelated-baseline", "unrelated-fork"].includes(scenario)) {
        NodeAssert.throws(() => auditedOverlay(args));
        NodeAssert.equal(run(["rev-parse", "HEAD"]), source);
        NodeAssert.equal(run(["status", "--porcelain"]), "");
        return;
      }
      const overlay = auditedOverlay(args);
      NodeAssert.equal(overlay.source, source);
      NodeAssert.doesNotMatch(overlay.patch, /runtime-feature|\.fork\/|\.github\//);
      const apply = () => run(["apply", "--3way", "-"], { input: `${overlay.patch}\n` });
      if (scenario === "apply-conflict") {
        NodeAssert.throws(apply);
        NodeAssert.match(run(["diff", "--name-only", "--diff-filter=U"]), /fork.txt/);
      } else {
        apply();
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(directory, "fork.txt"), "utf8"),
          "new fork fix\n",
        );
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(directory, "app.txt"), "utf8"),
          "tagged application\n",
        );
      }
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(directory, "runtime-feature.txt")), false);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
}

NodeTest.test("push validates its snapshot while scheduled and manual runs merge upstream", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-cadence-"));
  const run = (cwd, ...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  try {
    const upstream = NodePath.join(directory, "upstream");
    NodeFS.mkdirSync(upstream);
    run(upstream, "init", "--initial-branch=main");
    run(upstream, "config", "user.name", "Test");
    run(upstream, "config", "user.email", "test@example.invalid");
    run(upstream, "config", "commit.gpgSign", "false");
    NodeFS.writeFileSync(NodePath.join(upstream, "app.txt"), "reviewed baseline\n");
    run(upstream, "add", "-A");
    run(upstream, "commit", "-m", "baseline");
    const baseline = run(upstream, "rev-parse", "HEAD");
    NodeFS.writeFileSync(NodePath.join(upstream, "app.txt"), "new upstream feature\n");
    run(upstream, "commit", "-am", "new upstream");

    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      const fork = NodePath.join(directory, event);
      run(directory, "clone", "--quiet", upstream, fork);
      run(fork, "reset", "--hard", baseline);
      run(fork, "config", "user.name", "Test");
      run(fork, "config", "user.email", "test@example.invalid");
      run(fork, "config", "commit.gpgSign", "false");
      run(fork, "remote", "add", "upstream", upstream);
      for (const path of [".github/scripts", ".github/workflows", ".fork", "scripts"])
        NodeFS.mkdirSync(NodePath.join(fork, path), { recursive: true });
      NodeFS.copyFileSync(
        new URL("./fork-maintenance.mjs", import.meta.url),
        NodePath.join(fork, ".github/scripts/fork-maintenance.mjs"),
      );
      NodeFS.writeFileSync(
        NodePath.join(fork, ".github/workflows/fork-maintenance.yml"),
        "name: fixture\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(fork, "scripts/i18n-upstream.mjs"),
        "// fixture: no native localization\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(fork, ".fork/config.json"),
        JSON.stringify({
          repository: "fixture/fork",
          repositoryId: 123,
          upstream: "fixture/upstream",
        }),
      );
      run(fork, "add", "-A");
      run(fork, "commit", "-m", "fork maintenance");
      const original = run(fork, "rev-parse", "HEAD");
      const output = NodePath.join(directory, `${event}-output`);
      NodeChildProcess.execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        globalThis.fetch = async (url) => {
          if (url !== 'https://api.github.com/repos/fixture/fork') throw new Error('Unexpected request');
          return Response.json({ id: 123 });
        };
        process.argv = [process.execPath, process.cwd() + '/.github/scripts/fork-maintenance.mjs', 'sync'];
        await import(process.argv[1]);
      `,
        ],
        {
          cwd: fork,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            GITHUB_REPOSITORY: "fixture/fork",
            GITHUB_EVENT_NAME: event,
            GITHUB_OUTPUT: output,
          },
        },
      );
      NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), `original=${original}\n`);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fork, "app.txt"), "utf8"),
        event === "push" ? "reviewed baseline\n" : "new upstream feature\n",
      );
      NodeAssert.equal(run(fork, "config", "user.name"), "github-actions[bot]");
      NodeAssert.equal(run(fork, "status", "--porcelain"), "");
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

