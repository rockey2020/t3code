import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  classifyDependency,
  planUpdates,
  runTransaction,
  assertReleaseAgePolicy,
} from "./fork-upgrade-dependencies.mjs";

NodeTest.test(
  "protects patched packages, override edges, aliases and coupled dependency families",
  () => {
    const workspace = {
      patchedDependencies: { "@scope/patched@1.0.0": "patch" },
      overrides: { "parent>forced": "1.0.0", catalogued: "catalog:" },
    };
    for (const name of [
      "@scope/patched",
      "forced",
      "react",
      "expo-new-module",
      "@effect/new-module",
      "vite-plus",
    ]) {
      NodeAssert.ok(classifyDependency(name, "1.0.0", workspace), name);
    }
    NodeAssert.equal(classifyDependency("catalogued", "1.0.0", workspace), null);
    NodeAssert.ok(classifyDependency("alias", "npm:other@1.0.0", workspace));
    NodeAssert.ok(classifyDependency("local", "file:../local", workspace));
    NodeAssert.equal(classifyDependency("new-upstream-library", "^1.2.3", workspace), null);
  },
);

NodeTest.test(
  "discovers new dependencies, separates majors and never downgrades or drops a prerelease pin",
  () => {
    const refs = [
      { name: "new-upstream-library", version: "^1.2.3" },
      { name: "major", version: "~1.0.0" },
      { name: "ahead", version: "5.0.0" },
      { name: "preview", version: "2.0.0-beta.1" },
    ];
    const result = planUpdates(
      refs,
      {},
      { "new-upstream-library": "1.3.0", major: "2.0.0", ahead: "4.0.0", preview: "1.9.0" },
    );
    NodeAssert.deepEqual(
      result.updates.map(({ name, target, group }) => ({ name, target, group })),
      [
        { name: "new-upstream-library", target: "^1.3.0", group: "compatible" },
        { name: "major", target: "~2.0.0", group: "major" },
      ],
    );
    NodeAssert.equal(result.held.find((item) => item.name === "preview").latest, "1.9.0");
  },
);

NodeTest.test(
  "a failed verification restores original manifests and lockfile before continuing",
  async () => {
    let files = "baseline";
    const result = await runTransaction({
      snapshot: () => files,
      apply: () => {
        files = "candidate";
      },
      verify: () => {
        throw new Error("peer conflict");
      },
      restore: (saved) => {
        files = saved;
      },
    });
    NodeAssert.equal(files, "baseline");
    NodeAssert.equal(result.ok, false);
    NodeAssert.match(result.error, /peer conflict/);
  },
);

NodeTest.test(
  "holds the editor family until the observed input-rule undo regression is migrated",
  () => {
    for (const name of [
      "@tiptap/core",
      "@tiptap/extension-bold",
      "prosemirror-view",
      "prosemirror-transform",
    ]) {
      NodeAssert.match(classifyDependency(name, "3.31.3", {}) ?? "", /Backspace.*input.rule/i);
    }
    const plan = planUpdates(
      [
        { name: "@tiptap/core", version: "3.31.3" },
        { name: "unrelated-package", version: "1.0.0" },
      ],
      {},
      { "@tiptap/core": "3.33.1", "unrelated-package": "1.0.1" },
    );
    NodeAssert.deepEqual(
      plan.updates.map((item) => item.name),
      ["unrelated-package"],
    );
    NodeAssert.equal(plan.held[0].latest, "3.33.1");
  },
);

NodeTest.test("holds fresh or undated releases without blocking mature candidates", () => {
  const now = Date.parse("2026-11-12T00:00:00Z");
  const refs = ["fresh", "mature", "undated"].map((name) => ({ name, version: "1.0.0" }));
  const plan = planUpdates(
    refs,
    {},
    { fresh: "1.0.1", mature: "1.0.1", undated: "1.0.1" },
    {
      now,
      publishedAt: { fresh: "2026-11-11T23:00:00Z", mature: "2026-11-10T00:00:00Z" },
    },
  );
  NodeAssert.deepEqual(
    plan.updates.map((item) => item.name),
    ["mature"],
  );
  NodeAssert.deepEqual(
    plan.held.map((item) => item.name),
    ["fresh", "undated"],
  );
  NodeAssert.match(plan.held[0].reason, /release age/i);
  NodeAssert.equal(plan.held[0].eligibleAfter, "2026-11-12T23:00:00.000Z");
  NodeAssert.equal(
    planUpdates(
      refs.slice(0, 1),
      { minimumReleaseAge: 30 },
      { fresh: "1.0.1" },
      {
        now,
        publishedAt: { fresh: "2026-11-11T23:00:00Z" },
      },
    ).updates.length,
    1,
  );
});

NodeTest.test("rejects install-time release-age exceptions or a weakened age floor", () => {
  const before = { minimumReleaseAge: 1440, minimumReleaseAgeExclude: ["approved@1.0.0"] };
  NodeAssert.doesNotThrow(() => assertReleaseAgePolicy(before, before));
  NodeAssert.throws(
    () =>
      assertReleaseAgePolicy(before, {
        ...before,
        minimumReleaseAgeExclude: ["approved@1.0.0", "fresh@2.0.0"],
      }),
    /release.age/i,
  );
  NodeAssert.throws(
    () => assertReleaseAgePolicy(before, { ...before, minimumReleaseAge: 0 }),
    /release.age/i,
  );
  NodeAssert.throws(
    () => assertReleaseAgePolicy(before, { ...before, minimumReleaseAgeIgnoreMissingTime: true }),
    /release.age/i,
  );
});
