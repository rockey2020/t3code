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
  commitPreparedSource,
} from "./fork-maintenance.mjs";

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
    NodeAssert.equal(auditedOverlay({ ...args, readBaseline: () => "different-upstream" }), null);
    NodeAssert.equal(auditedOverlay({ ...args, isAncestor: () => false }), null);
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
      write(".github/workflows/fork-build.yml", "name: Approved fork build\n");
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
