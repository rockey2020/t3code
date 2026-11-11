// Scheduled fork maintenance. Dry-run by default; never commits or pushes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const sections = ["dependencies", "devDependencies", "optionalDependencies"];
const coupled =
  /^(?:react$|react-dom$|react-native(?:$|-)|@react-native\/|@react-navigation\/|@types\/react(?:$|-)|expo(?:$|-)|@expo\/|effect$|@effect\/|alchemy$|@alchemy\.run\/|@distilled\.cloud\/|vite$|vite-plus$|@voidzero-dev\/|@vitest\/|@opencode\/|@pierre\/|electron$|electron-builder$|electron-webauthn$|@electron-webauthn\/|objc-js$|@tailwindcss\/|tailwindcss$|lightningcss$|@noble\/|@clerk\/)/;
const versionPattern = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/;

function overrideName(selector) {
  const name = selector.split(">").at(-1);
  return name.replace(/@[^@/]*$/, "");
}

export function classifyDependency(name, version, workspace) {
  if (!versionPattern.test(version))
    return "Local, alias, prerelease or complex range requires review";
  if (Object.keys(workspace.patchedDependencies ?? {}).some((key) => overrideName(key) === name)) {
    return "Pinned patch must be rebased and tested first";
  }
  if (
    Object.entries(workspace.overrides ?? {}).some(
      ([key, value]) => overrideName(key) === name && value !== "catalog:",
    )
  ) {
    return "Explicit override must be reviewed with its dependency constraints";
  }
  // TipTap 3.33 splits input insertion from rule conversion. Our list normalization
  // runs between them, losing the undo state. Keep this family together until
  // composer-block-shortcuts.test.ts passes with a coordinated migration.
  if (/^(?:@tiptap\/|prosemirror-)/.test(name))
    return "Temporary migration hold: Backspace no longer restores the literal marker after an input-rule conversion";
  if (coupled.test(name)) return "Coupled runtime/toolchain family requires coordinated migration";
  return null;
}

export function planUpdates(refs, workspace, latest, age) {
  const updates = [];
  const held = [];
  for (const ref of refs) {
    const reason = classifyDependency(ref.name, ref.version, workspace);
    const next = latest[ref.name];
    if (reason) {
      held.push({ ...ref, latest: next ?? null, reason });
      continue;
    }
    const oldParts = ref.version.match(versionPattern);
    const newParts = next?.match(versionPattern);
    if (!newParts) {
      held.push({ ...ref, latest: next ?? null, reason: "Latest stable version unavailable" });
      continue;
    }
    const oldVersion = oldParts.slice(2).map(Number);
    const newVersion = newParts.slice(2).map(Number);
    const different = oldVersion.findIndex((part, index) => part !== newVersion[index]);
    if (different < 0 || newVersion[different] < oldVersion[different]) continue;
    // pnpm 12 defaults to a one-day cutoff. Pre-filter direct updates so a fresh
    // release does not roll back unrelated mature packages. Strict pnpm install
    // still enforces the complete transitive graph and configured exceptions.
    const minimumAge = Number(workspace.minimumReleaseAge ?? 1440);
    if (age && minimumAge > 0) {
      const published = Date.parse(age.publishedAt[ref.name] ?? "");
      const eligibleAt = published + minimumAge * 60_000;
      if (!Number.isFinite(eligibleAt) || eligibleAt > age.now) {
        held.push({
          ...ref,
          latest: next,
          reason: Number.isFinite(eligibleAt)
            ? "Minimum release age has not elapsed"
            : "Missing publication time; cannot verify minimum release age",
          ...(Number.isFinite(eligibleAt)
            ? { eligibleAfter: new Date(eligibleAt).toISOString() }
            : {}),
        });
        continue;
      }
    }
    updates.push({
      ...ref,
      target: `${oldParts[1]}${next}`,
      group:
        oldVersion[0] === newVersion[0] && (oldVersion[0] !== 0 || oldVersion[1] === newVersion[1])
          ? "compatible"
          : "major",
    });
  }
  return { updates, held };
}

export function assertReleaseAgePolicy(before, after) {
  const approved = new Set(before.minimumReleaseAgeExclude ?? []);
  if (
    (after.minimumReleaseAgeExclude ?? []).some((entry) => !approved.has(entry)) ||
    Number(after.minimumReleaseAge ?? 1440) < Number(before.minimumReleaseAge ?? 1440) ||
    (after.minimumReleaseAgeIgnoreMissingTime === true &&
      before.minimumReleaseAgeIgnoreMissingTime !== true)
  ) {
    throw new Error(
      "Install weakened the minimum release-age policy; rolling back without adding exceptions",
    );
  }
}

export async function runTransaction({ snapshot, apply, verify, restore }) {
  const saved = await snapshot();
  try {
    await apply();
    await verify();
    return { ok: true };
  } catch (error) {
    await restore(saved);
    return { ok: false, error: String(error) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex < 0 ? "fork-dependency-report.json" : args[reportIndex + 1];
  const verifyIndex = args.indexOf("--verify");
  const verify =
    verifyIndex < 0 ? "vp run check:changed && vp run build:desktop" : args[verifyIndex + 1];
  if (!reportPath || !verify) throw new Error("--report and --verify require a value");
  const root = process.cwd();
  // yaml is an existing server dependency; no unpinned npx bootstrap or new dependency.
  const require = NodeModule.createRequire(NodePath.resolve(root, "apps/server/package.json"));
  const { parseDocument } = require("yaml");
  const workspacePath = "pnpm-workspace.yaml";
  const workspaceText = NodeFS.readFileSync(workspacePath, "utf8");
  const doc = parseDocument(workspaceText);
  if (doc.errors.length) throw new Error(`Invalid workspace YAML: ${doc.errors.join("; ")}`);
  const workspace = doc.toJS();
  const paths = [
    ...new Set([
      "package.json",
      ...NodeFS.globSync(workspace.packages.map((pattern) => `${pattern}/package.json`)),
    ]),
  ];
  const originals = new Map(paths.map((path) => [path, NodeFS.readFileSync(path, "utf8")]));
  originals.set(workspacePath, workspaceText);
  originals.set("pnpm-lock.yaml", NodeFS.readFileSync("pnpm-lock.yaml", "utf8"));
  // Router validation/builds regenerate this tracked file. Restore it too if
  // an upgrade fails, so a reverted router never keeps a newer generated tree.
  const routeTree = "apps/web/src/routeTree.gen.ts";
  if (NodeFS.existsSync(routeTree))
    originals.set(routeTree, NodeFS.readFileSync(routeTree, "utf8"));
  const manifests = new Map(paths.map((path) => [path, JSON.parse(originals.get(path))]));
  const refs = [];
  for (const [name, version] of Object.entries(workspace.catalog ?? {}))
    refs.push({ name, version, path: workspacePath, keys: ["catalog", name] });
  for (const [catalog, values] of Object.entries(workspace.catalogs ?? {})) {
    for (const [name, version] of Object.entries(values))
      refs.push({ name, version, path: workspacePath, keys: ["catalogs", catalog, name] });
  }
  for (const [path, manifest] of manifests) {
    for (const section of sections) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (!version.startsWith("catalog:") && !version.startsWith("workspace:"))
          refs.push({ name, version, path, keys: [section, name] });
      }
    }
  }
  const latest = {};
  const publishedAt = {};
  const lookupFailures = [];
  // npm honors the runner's configured registry. Queries do not execute package code.
  const npm = NodeUtil.promisify(NodeChildProcess.execFile);
  const queue = [
    ...new Set(
      refs
        .filter((ref) => !/^(?:file:|link:|workspace:|git|https?:|npm:)/.test(ref.version))
        .map((ref) => ref.name),
    ),
  ];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const name = queue.shift();
        try {
          const { stdout } = await npm(
            "npm",
            [
              "view",
              name,
              "dist-tags.latest",
              "time",
              "--json",
              "--fetch-retries=1",
              "--fetch-timeout=20000",
            ],
            { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
          );
          const metadata = JSON.parse(stdout);
          latest[name] = metadata["dist-tags.latest"];
          publishedAt[name] = metadata.time?.[latest[name]];
        } catch (error) {
          lookupFailures.push({ name, error: String(error) });
        }
      }
    }),
  );
  const plan = planUpdates(refs, workspace, latest, { publishedAt, now: Date.now() });
  const compatible = plan.updates.filter((item) => item.group === "compatible");
  const report = {
    checkedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    checked: Object.keys(latest).length,
    lookupFailures,
    proposed: compatible,
    held: [
      ...plan.held,
      ...plan.updates
        .filter((item) => item.group === "major")
        .map((item) => ({
          ...item,
          reason: "Breaking major (or 0.x minor) requires migration review",
        })),
    ],
    applied: [],
    failed: [],
  };
  if (apply && compatible.length) {
    const transaction = await runTransaction({
      snapshot: () => originals,
      apply: () => {
        const modified = new Set();
        for (const item of compatible) {
          if (item.path === workspacePath) doc.setIn(item.keys, item.target);
          else manifests.get(item.path)[item.keys[0]][item.name] = item.target;
          modified.add(item.path);
        }
        for (const path of modified)
          NodeFS.writeFileSync(
            path,
            path === workspacePath
              ? doc.toString()
              : `${JSON.stringify(manifests.get(path), null, 2)}\n`,
          );
        NodeChildProcess.execFileSync(
          "pnpm",
          ["install", "--no-frozen-lockfile", "--config.minimum-release-age-strict=true"],
          {
            stdio: "inherit",
            timeout: 10 * 60 * 1000,
          },
        );
        assertReleaseAgePolicy(
          workspace,
          parseDocument(NodeFS.readFileSync(workspacePath, "utf8")).toJS(),
        );
      },
      verify: () =>
        NodeChildProcess.execSync(verify, { stdio: "inherit", timeout: 20 * 60 * 1000 }),
      restore: (saved) => {
        for (const [path, contents] of saved) NodeFS.writeFileSync(path, contents);
      },
    });
    if (transaction.ok) report.applied = compatible;
    else {
      report.failed.push({
        group: "compatible",
        dependencies: compatible,
        error: transaction.error,
      });
      // Restore installed state as well; failure here must block building with stale modules.
      NodeFS.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      NodeChildProcess.execFileSync(
        "pnpm",
        ["install", "--frozen-lockfile", "--config.minimum-release-age-strict=true"],
        {
          stdio: "inherit",
          timeout: 10 * 60 * 1000,
        },
      );
    }
  }
  NodeFS.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Dependencies: ${report.checked} checked, ${report.applied.length} applied, ${report.held.length} held, ${report.failed.length} failed groups, ${lookupFailures.length} lookup failures. Report: ${reportPath}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### Dependency maintenance\n${report.checked} packages checked; ${report.applied.length} updates applied; ${report.held.length} held for review; ${report.failed.length} failed groups; ${lookupFailures.length} registry lookup failures. See dependency report artifact.\n`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
