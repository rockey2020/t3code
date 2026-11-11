// @effect-diagnostics nodeBuiltinImport:off - Public certificate fixtures exercise signing policy without private keys.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findReleaseApp, selectMacReleaseArchives } from "./verify-macos-signing.ts";
import * as NodeTls from "node:tls";
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  normalizeCertificateFingerprint,
  resolveMacSelfSignedEnvironment,
  selectPinnedCertificate,
  certificateRequirement,
  validateSelfSignedMode,
} from "./lib/mac-self-signing.ts";

const certificate = NodeFS.readFileSync(
  new URL("../.fork/macos-signing-certificate.pem", import.meta.url),
  "utf8",
);
const fingerprint = "08A07C3F1FFA9CBE3A7AFE0CD040DC35500DE70AEDE97F6242BDA255D25D6F53";
const now = Date.parse("2027-01-01T00:00:00Z");

it("requires a complete fixed SHA256 fingerprint and explicit keychain", () => {
  assert.equal(
    normalizeCertificateFingerprint(fingerprint.toLowerCase().match(/../g)!.join(":")),
    fingerprint,
  );
  for (const value of ["", "-", "a".repeat(40), "g".repeat(64)])
    assert.throws(() => normalizeCertificateFingerprint(value));
  assert.throws(() => resolveMacSelfSignedEnvironment({}), /fingerprint/i);
  assert.throws(
    () => resolveMacSelfSignedEnvironment({ T3CODE_MAC_SIGN_CERT_SHA256: fingerprint }),
    /keychain/i,
  );
  assert.deepEqual(
    resolveMacSelfSignedEnvironment({
      T3CODE_MAC_SIGN_CERT_SHA256: fingerprint,
      CSC_KEYCHAIN: "/tmp/sign.keychain-db",
    }),
    { certificateSha256: fingerprint, keychain: "/tmp/sign.keychain-db" },
  );
});

it("selects only the pinned self-signed code-signing certificate", () => {
  const selected = selectPinnedCertificate(
    `${NodeTls.rootCertificates[0]}\n${certificate}`,
    fingerprint,
    now,
  );
  assert.equal(normalizeCertificateFingerprint(selected.fingerprint256), fingerprint);
  assert.throws(() => selectPinnedCertificate(certificate, "A".repeat(64), now), /not found/i);
  assert.throws(
    () => selectPinnedCertificate(certificate, fingerprint, Date.parse("2040-01-01")),
    /expired/i,
  );
  assert.throws(
    () => selectPinnedCertificate(certificate, fingerprint, Date.parse("2020-01-01")),
    /valid/i,
  );
  const root = new NodeCrypto.X509Certificate(NodeTls.rootCertificates[0]!);
  assert.throws(
    () =>
      selectPinnedCertificate(
        root.toString(),
        normalizeCertificateFingerprint(root.fingerprint256),
        Date.parse(root.validFrom) + 1000,
      ),
    /CA|code.signing/i,
  );
});

it("pins a certificate leaf without requiring system trust", () => {
  const cert = selectPinnedCertificate(certificate, fingerprint, now);
  assert.equal(
    certificateRequirement(cert),
    `certificate leaf = H"${cert.fingerprint.replaceAll(":", "")}"`,
  );
  assert.notInclude(certificateRequirement(cert), "trusted");
});

it("never permits self-signing on another platform or together with Apple signing", () => {
  assert.doesNotThrow(() => validateSelfSignedMode("mac", false, true));
  assert.doesNotThrow(() => validateSelfSignedMode("win", true, false));
  assert.throws(() => validateSelfSignedMode("win", false, true), /macOS/i);
  assert.throws(() => validateSelfSignedMode("mac", true, true), /mutually exclusive/i);
});

it("requires the complete matching DMG and ZIP release pair", () => {
  assert.deepEqual(
    selectMacReleaseArchives(["T3-Code-1.0-arm64.zip", "other.txt", "T3-Code-1.0-arm64.dmg"]),
    ["T3-Code-1.0-arm64.dmg", "T3-Code-1.0-arm64.zip"],
  );
  assert.throws(() => selectMacReleaseArchives(["T3-Code-1.0-arm64.dmg"]));
  assert.throws(() => selectMacReleaseArchives(["T3-Code-1.0-arm64.dmg", "T3-Code-2.0-arm64.zip"]));
  assert.throws(() =>
    selectMacReleaseArchives([
      "T3-Code-1.0-arm64.dmg",
      "T3-Code-1.0-arm64.zip",
      "T3-Code-2.0-arm64.zip",
    ]),
  );
});

it("rejects missing, ambiguous, or symlinked applications in an archive", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-verify-app-test-"));
  try {
    assert.throws(() => findReleaseApp(scratch));
    const app = NodePath.join(scratch, "T3 Code.app");
    NodeFS.mkdirSync(app);
    assert.equal(findReleaseApp(scratch), app);
    const link = NodePath.join(scratch, "Another.app");
    NodeFS.symlinkSync(app, link);
    assert.throws(() => findReleaseApp(scratch));
    NodeFS.rmSync(app, { recursive: true });
    assert.throws(() => findReleaseApp(scratch), /symlink/);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});
