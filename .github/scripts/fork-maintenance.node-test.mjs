import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  releaseChannel,
  selectReleases,
  releaseComplete,
  auditedOverlay,
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
