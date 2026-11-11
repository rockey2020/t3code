import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { validateMacSigningManifest } from "./fork-signing.mjs";

const fingerprint = "AB".repeat(32);
const config = { mode: "self-signed", certificateSha256: fingerprint };
const hashes = {
  "T3-Code-0.1.9-arm64.dmg": "01".repeat(32),
  "T3-Code-0.1.9-arm64.zip": "02".repeat(32),
  "T3-Code-0.1.9-x64.exe": "03".repeat(32),
};
const fixture = () => ({
  schemaVersion: 1,
  signing: "self-signed",
  certificateSha256: fingerprint,
  notarized: false,
  artifacts: Object.entries(hashes)
    .filter(([name]) => !name.endsWith(".exe"))
    .map(([name, sha256]) => ({
      name,
      sha256,
      appIdentifier: "com.t3tools.t3code",
      signatureVerified: true,
      certificateSha256: fingerprint,
      notarized: false,
    })),
});

NodeTest.test("accepts both matching signed packages and keeps Windows separate", () => {
  NodeAssert.deepEqual(validateMacSigningManifest(config, fixture(), hashes), {
    type: "self-signed",
    certificateSha256: fingerprint,
    notarized: false,
  });
});

for (const [name, change] of [
  ["changed certificate", (m) => (m.certificateSha256 = "CD".repeat(32))],
  ["ad-hoc signature", (m) => (m.signing = "ad-hoc")],
  ["false notarization claim", (m) => (m.notarized = true)],
  ["missing ZIP verification", (m) => m.artifacts.pop()],
  ["duplicate artifact", (m) => (m.artifacts[1] = m.artifacts[0])],
  ["changed installer bytes", (m) => (m.artifacts[0].sha256 = "04".repeat(32))],
  ["failed signature verification", (m) => (m.artifacts[0].signatureVerified = false)],
  ["different app", (m) => (m.artifacts[0].appIdentifier = "other.app")],
  ["different nested certificate", (m) => (m.artifacts[0].certificateSha256 = "CD".repeat(32))],
]) {
  NodeTest.test(`rejects ${name}`, () => {
    const manifest = fixture();
    change(manifest);
    NodeAssert.throws(() => validateMacSigningManifest(config, manifest, hashes));
  });
}

NodeTest.test("rejects missing fixed configuration or missing package", () => {
  NodeAssert.throws(() => validateMacSigningManifest({}, fixture(), hashes));
  NodeAssert.throws(() =>
    validateMacSigningManifest(config, fixture(), { "T3-Code-0.1.9-arm64.dmg": "01".repeat(32) }),
  );
});
