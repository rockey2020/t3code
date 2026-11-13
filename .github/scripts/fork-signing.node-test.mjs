import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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

function signingStepFixture(t, { brewStatus = 0, version, missingBinary = false } = {}) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-signing-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const bin = NodePath.join(directory, "bin");
  const prefix = NodePath.join(directory, "Homebrew OpenSSL 3");
  NodeFS.mkdirSync(bin);
  NodeFS.mkdirSync(NodePath.join(prefix, "bin"), { recursive: true });
  const executable = (path, body) =>
    NodeFS.writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 });
  executable(
    NodePath.join(bin, "brew"),
    `[[ "$*" == "--prefix --installed openssl@3" ]]\nexit_status=${brewStatus}\n[[ "$exit_status" == 0 ]] || exit "$exit_status"\nprintf '%s\\n' "$TEST_OPENSSL_PREFIX"`,
  );
  executable(
    NodePath.join(bin, "openssl"),
    'echo "Unexpected PATH OpenSSL/LibreSSL invocation" >&2\nexit 91',
  );
  if (!missingBinary) {
    executable(
      NodePath.join(prefix, "bin", "openssl"),
      version === undefined ? 'exec "$TEST_REAL_OPENSSL" "$@"' : `printf '%s\\n' '${version}'`,
    );
  }
  // Linux substitutes for macOS base64 and Keychain; all cryptographic operations stay real.
  executable(
    NodePath.join(bin, "base64"),
    '[[ "$*" == "-D" ]]\n"$TEST_NODE" --input-type=module -e \'import { readFileSync } from "node:fs"; process.stdout.write(Buffer.from(readFileSync(0, "utf8"), "base64"));\'',
  );
  executable(
    NodePath.join(bin, "security"),
    `case "$1" in
  list-keychains) printf '"%s/login.keychain-db"\\n' "$RUNNER_TEMP" ;;
  create-keychain|set-keychain-settings|unlock-keychain) ;;
  import) [[ -s "$2" ]] && exit 79 ;;
  *) exit 92 ;;
esac`,
  );
  const workflow = NodeFS.readFileSync(
    new URL("../workflows/release-desktop.yml", import.meta.url),
    "utf8",
  );
  const step = workflow
    .split("      - name: Import the fixed fork macOS signing identity\n")[1]
    .split("\n      - name:")[0];
  const script = step.split("        run: |\n")[1].replace(/^          /gm, "");
  const env = {
    ...process.env,
    PATH: `${bin}${NodePath.delimiter}${NodePath.dirname(process.execPath)}${NodePath.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: directory,
    TEST_NODE: process.execPath,
    TEST_OPENSSL_PREFIX: prefix,
    TEST_REAL_OPENSSL: NodeChildProcess.execFileSync("which", ["openssl"], {
      encoding: "utf8",
    }).trim(),
    FORK_MACOS_CERTIFICATE_P12: "not-a-certificate",
    FORK_MACOS_CERTIFICATE_PASSWORD: "fixture-password",
  };
  return {
    directory,
    env,
    openssl: (args) =>
      NodeChildProcess.execFileSync(env.TEST_REAL_OPENSSL, args, {
        cwd: directory,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    run: () =>
      NodeChildProcess.spawnSync("bash", ["-c", script], { cwd: directory, env, encoding: "utf8" }),
  };
}

NodeTest.test("signing import uses Homebrew OpenSSL 3 despite a LibreSSL first on PATH", (t) => {
  const f = signingStepFixture(t);
  f.openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "key.pem",
    "-out",
    "cert.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Signing test fixture",
  ]);
  f.openssl([
    "pkcs12",
    "-export",
    "-inkey",
    "key.pem",
    "-in",
    "cert.pem",
    "-out",
    "input.p12",
    "-passout",
    "env:FORK_MACOS_CERTIFICATE_PASSWORD",
  ]);
  const expectedCertificate = new NodeCrypto.X509Certificate(
    NodeFS.readFileSync(NodePath.join(f.directory, "cert.pem")),
  );
  NodeFS.mkdirSync(NodePath.join(f.directory, ".fork"));
  NodeFS.writeFileSync(
    NodePath.join(f.directory, ".fork/macos-signing.json"),
    JSON.stringify({ certificateSha256: expectedCertificate.fingerprint256.replaceAll(":", "") }),
  );
  f.env.FORK_MACOS_CERTIFICATE_P12 = NodeFS.readFileSync(
    NodePath.join(f.directory, "input.p12"),
  ).toString("base64");
  const result = f.run();
  NodeAssert.equal(result.status, 79, result.stderr);
  NodeAssert.doesNotMatch(result.stderr, /Unexpected PATH/);
  NodeAssert.match(result.stderr, /MAC: sha1, Iteration 100000/);
  NodeAssert.match(
    result.stderr,
    /PKCS7 Encrypted data: pbeWithSHA1And3-KeyTripleDES-CBC, Iteration 100000/,
  );
  NodeAssert.match(
    result.stderr,
    /Shrouded Keybag: pbeWithSHA1And3-KeyTripleDES-CBC, Iteration 100000/,
  );
  const importedCertificate = new NodeCrypto.X509Certificate(
    NodeFS.readFileSync(NodePath.join(f.directory, "t3-fork-macos-signing/certificate.pem")),
  );
  NodeAssert.equal(importedCertificate.fingerprint256, expectedCertificate.fingerprint256);
});

for (const [name, options] of [
  ["missing Homebrew formula", { brewStatus: 1 }],
  ["missing OpenSSL executable", { missingBinary: true }],
  ["LibreSSL executable", { version: "LibreSSL 3.3.6" }],
  ["OpenSSL 1 executable", { version: "OpenSSL 1.1.1w  11 Sep 2023" }],
  ["OpenSSL 4 executable", { version: "OpenSSL 4.0.0" }],
]) {
  NodeTest.test(
    `signing import rejects ${name} before decoding secrets without PATH fallback`,
    (t) => {
      const f = signingStepFixture(t, options);
      const result = f.run();
      NodeAssert.equal(result.status, 1, result.stderr);
      NodeAssert.doesNotMatch(result.stderr, /Unexpected PATH/);
      NodeAssert.equal(
        NodeFS.existsSync(NodePath.join(f.directory, "t3-fork-macos-signing")),
        false,
      );
    },
  );
}
