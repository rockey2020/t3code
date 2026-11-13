import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../workflows/${path}`, import.meta.url), 'utf8');

test('source maintenance owns the release graph without dispatch or workflow-wide locks', () => {
  const maintenance = read('fork-maintenance.yml');
  assert.doesNotMatch(maintenance, /^concurrency:/m);
  assert.match(maintenance, /concurrency:\n      group: fork-maintenance-source\n      cancel-in-progress: false/);
  assert.match(maintenance, /fail-fast: false/);
  assert.match(maintenance, /uses: .\/.github\/workflows\/fork-release.yml/);
  assert.match(maintenance, /always\(\).*has_builds == 'true'/);
  assert.doesNotMatch(maintenance, /secrets: inherit|actions: write/);
  assert.match(maintenance, /id: prepare/);
  const script = readFileSync(new URL('./fork-maintenance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\/dispatches|\/enable|dispatchDesktopBuilds/);
  assert.match(script, /output\(name, value\)/);
});

test('pure release call gates packages on snapshot, channel identity and successful native verification', () => {
  const graph = read('fork-release.yml');
  assert.match(graph, /workflow_call:/);
  assert.doesNotMatch(graph, /workflow_dispatch:|schedule:|secrets: inherit/);
  assert.match(graph, /WORKFLOW_SHA: \$\{\{ github.workflow_sha \}\}/);
  assert.match(graph, /fork-release-check.mjs/);
  assert.match(graph, /needs: preflight/);
  assert.match(graph, /needs.preflight.outputs.build_needed == 'true'/);
  assert.match(graph, /needs: \[mac, windows\]/);
  assert.match(graph, /needs.mac.result == 'success' && needs.windows.result == 'success'/);
  assert.match(graph, /runner: macos-15\n/);
  assert.match(graph, /verify_runner: windows-2025/);
  assert.match(graph, /launch_check: true/);
  assert.match(graph, /cancel-in-progress: false/);
  assert.match(graph, /pattern: \$\{\{ inputs.artifact_namespace \}\}desktop-\*/);
  assert.doesNotMatch(graph, /blacksmith|macos-26/);
  for (const job of ['preflight', 'bundle', 'wsl', 'mac', 'windows']) {
    const text = graph.split(`\n  ${job}:\n`)[1].split(/\n  \w+:\n/)[0];
    assert.match(text, /permissions:\n      actions: read\n      contents: read/, job);
  }
});

test('every release artifact is namespace isolated with a compatible empty default', () => {
  const workflow = read('release-desktop.yml');
  assert.match(workflow, /artifact_namespace:\n        required: false\n        default: ""\n        type: string/);
  const steps = workflow.split(/\n      - /);
  const artifactSteps = steps.filter((step) => /uses: actions\/(?:upload|download)-artifact@/.test(step));
  assert.ok(artifactSteps.length >= 12);
  for (const step of artifactSteps) assert.match(step, /name: \$\{\{ inputs.artifact_namespace \}\}/, step.split('\n')[0]);
  assert.match(workflow, /ARTIFACT: \$\{\{ inputs.artifact_namespace \}\}cli-linux-/);
  assert.match(workflow, /LINUX_JOB: \$\{\{ inputs.artifact_namespace \}\}Build Linux/);
  assert.match(workflow, /\$_.name -eq \$env:LINUX_JOB -or \$_.name.EndsWith\(" \/ \$env:LINUX_JOB"\)/);
});
