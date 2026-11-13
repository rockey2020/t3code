import * as NodeTest from 'node:test';
import * as NodeAssert from 'node:assert/strict';
import { checkPreparedRelease } from './fork-release-check.mjs';
const source = 'a'.repeat(40), fork = 'b'.repeat(40), upstream = 'c'.repeat(40), tree = 'd'.repeat(40);
const descriptor = { ref: source, version: '0.1.9', tag: 'v0.1.9-zh.0123456789ab', channel: 'stable', upstream_tag: 'v0.1.9', artifact_namespace: `stable-${source}-` };
const config = { repository: 'fixture/fork', repositoryId: 123, upstream: 'fixture/upstream', desktopTargets: ['mac-arm64', 'win-x64'] };
const build = { upstream: config.upstream, upstreamTag: 'v0.1.9', upstreamSha: upstream, forkSha: fork, fingerprint: '0123456789ab', channel: 'stable' };
function fixture(overrides = {}) {
  const assets = ['T3-Code-0.1.9-arm64.dmg', 'T3-Code-0.1.9-arm64.zip', 'T3-Code-0.1.9-x64.exe', 'SHA256SUMS', 'build-provenance.json', 'macos-signing.json'].map((name, index) => ({ name, id: index + 1, size: 10 }));
  const release = { draft: false, tag_name: descriptor.tag, prerelease: false, assets, ...overrides.release };
  const calls = [];
  return {
    calls,
    args: { descriptor, build, config, repository: config.repository, head: source, workflow: fork,
      run: () => tree,
      request: async (path) => {
        calls.push(path);
        if (path === 'repos/fixture/fork') return { id: 123 };
        if (path.includes('/releases/tags/')) return overrides.missing ? null : release;
        if (path.includes('/git/ref/tags/')) return overrides.missingTag ? null : { object: { type: 'commit', sha: overrides.tagSource ?? source } };
        if (path.endsWith('/releases/assets/5')) return { ...build, sourceCommit: source, targets: config.desktopTargets, appUpdatesEnabled: false, ...overrides.provenance };
        throw new Error(`Unexpected ${path}`);
      }, ...overrides.args,
    },
  };
}
NodeTest.test('exact complete release skips expensive platform jobs', async () => {
  const f = fixture(); NodeAssert.equal(await checkPreparedRelease(f.args), false);
});
NodeTest.test('missing draft or partial release proceeds to the existing publication gates', async () => {
  for (const options of [{ missing: true }, { release: { draft: true } }, { release: { assets: [] } }]) {
    const f = fixture(options); NodeAssert.equal(await checkPreparedRelease(f.args), true);
  }
});
NodeTest.test('explicit rebuild proceeds even for an identity-complete release', async () => {
  const f = fixture({ args: { rebuild: true } }); NodeAssert.equal(await checkPreparedRelease(f.args), true);
});
NodeTest.test('mismatched immutable identity or workflow fails closed before inspecting releases', async () => {
  for (const args of [{ head: fork }, { workflow: 'main' }, { run: ([, ref]) => ref.startsWith(source) ? tree : upstream }, { build: { ...build, channel: 'nightly' } }, { repository: 'other/fork' }]) {
    const f = fixture({ args }); await NodeAssert.rejects(checkPreparedRelease(f.args));
    NodeAssert.ok(!f.calls.some((path) => path.includes('/releases/')));
  }
});
NodeTest.test('a complete release with different tag or provenance never authorizes a skip', async () => {
  for (const options of [{ tagSource: fork }, { provenance: { sourceCommit: fork } }, { provenance: { upstreamSha: fork } }, { provenance: { appUpdatesEnabled: true } }, { provenance: { targets: ['linux'] } }]) {
    const f = fixture(options); await NodeAssert.rejects(checkPreparedRelease(f.args), /identity|provenance/i);
  }
});
NodeTest.test('incomplete draft without a materialized tag can be repaired', async () => {
  const f = fixture({ missingTag: true, release: { draft: true } });
  NodeAssert.equal(await checkPreparedRelease(f.args), true);
});
NodeTest.test('published installers without the required provenance do not trigger endless rebuilds', async () => {
  const f = fixture({ release: { assets: [
    { name: 'T3-Code-0.1.9-arm64.dmg', id: 1, size: 10 },
    { name: 'T3-Code-0.1.9-x64.exe', id: 2, size: 10 },
  ] } });
  await NodeAssert.rejects(checkPreparedRelease(f.args), /incomplete.*metadata/i);
});
