import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
const read = (path) =>
  NodeFS.readFileSync(new URL(`../workflows/${path}`, import.meta.url), "utf8");

NodeTest.test(
  "source maintenance owns the release graph without dispatch or workflow-wide locks",
  () => {
    const maintenance = read("fork-maintenance.yml");
    NodeAssert.doesNotMatch(maintenance, /^concurrency:/m);
    NodeAssert.match(
      maintenance,
      /concurrency:\n      group: fork-maintenance-source\n      cancel-in-progress: false/,
    );
    NodeAssert.match(maintenance, /fail-fast: false/);
    NodeAssert.match(maintenance, /uses: .\/.github\/workflows\/fork-release.yml/);
    NodeAssert.match(maintenance, /always\(\).*has_builds == 'true'/);
    NodeAssert.doesNotMatch(maintenance, /secrets: inherit|actions: write/);
    NodeAssert.match(maintenance, /id: prepare/);
    const script = NodeFS.readFileSync(new URL("./fork-maintenance.mjs", import.meta.url), "utf8");
    NodeAssert.doesNotMatch(script, /\/dispatches|\/enable|dispatchDesktopBuilds/);
    NodeAssert.match(script, /output\(name, value\)/);
  },
);

NodeTest.test(
  "pure release call gates packages on snapshot, channel identity and successful native verification",
  () => {
    const graph = read("fork-release.yml");
    NodeAssert.match(graph, /workflow_call:/);
    NodeAssert.doesNotMatch(graph, /workflow_dispatch:|schedule:|secrets: inherit/);
    NodeAssert.match(graph, /WORKFLOW_SHA: \$\{\{ github.workflow_sha \}\}/);
    NodeAssert.match(graph, /fork-release-check.mjs/);
    NodeAssert.match(graph, /needs: preflight/);
    NodeAssert.match(graph, /needs.preflight.outputs.build_needed == 'true'/);
    NodeAssert.match(graph, /needs: \[mac, windows\]/);
    NodeAssert.match(graph, /needs.mac.result == 'success' && needs.windows.result == 'success'/);
    NodeAssert.match(graph, /runner: macos-15\n/);
    NodeAssert.match(graph, /verify_runner: windows-2025/);
    NodeAssert.match(graph, /launch_check: true/);
    NodeAssert.match(graph, /cancel-in-progress: false/);
    NodeAssert.match(graph, /pattern: \$\{\{ inputs.artifact_namespace \}\}desktop-\*/);
    NodeAssert.doesNotMatch(graph, /blacksmith|macos-26/);
    for (const job of ["preflight", "bundle", "wsl", "mac", "windows"]) {
      const text = graph.split(`\n  ${job}:\n`)[1].split(/\n  \w+:\n/)[0];
      NodeAssert.match(text, /permissions:\n      actions: read\n      contents: read/, job);
    }
  },
);

NodeTest.test(
  "every release artifact is namespace isolated with a compatible empty default",
  () => {
    const workflow = read("release-desktop.yml");
    NodeAssert.match(
      workflow,
      /artifact_namespace:\n        required: false\n        default: ""\n        type: string/,
    );
    const steps = workflow.split(/\n      - /);
    const artifactSteps = steps.filter((step) =>
      /uses: actions\/(?:upload|download)-artifact@/.test(step),
    );
    NodeAssert.ok(artifactSteps.length >= 12);
    for (const step of artifactSteps)
      NodeAssert.match(step, /name: \$\{\{ inputs.artifact_namespace \}\}/, step.split("\n")[0]);
    NodeAssert.match(workflow, /ARTIFACT: \$\{\{ inputs.artifact_namespace \}\}cli-linux-/);
    NodeAssert.match(workflow, /LINUX_JOB: \$\{\{ inputs.artifact_namespace \}\}Build Linux/);
    NodeAssert.match(
      workflow,
      /\$_.name -eq \$env:LINUX_JOB -or \$_.name.EndsWith\(" \/ \$env:LINUX_JOB"\)/,
    );
  },
);
