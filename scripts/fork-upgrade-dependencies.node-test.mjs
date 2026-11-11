import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { classifyDependency, planUpdates, runTransaction } from "./fork-upgrade-dependencies.mjs";

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
