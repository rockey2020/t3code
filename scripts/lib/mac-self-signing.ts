// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Signing policy uses native X509 parsing and macOS tools.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function normalizeCertificateFingerprint(value: string): string {
  const fingerprint = value.trim().replaceAll(":", "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(fingerprint)) {
    throw new Error("A fixed SHA256 certificate fingerprint is required.");
  }
  return fingerprint;
}

export function resolveMacSelfSignedEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const certificateSha256 = normalizeCertificateFingerprint(env.T3CODE_MAC_SIGN_CERT_SHA256 ?? "");
  const keychain = env.CSC_KEYCHAIN?.trim();
  if (!keychain || !NodePath.isAbsolute(keychain))
    throw new Error("An absolute CSC_KEYCHAIN path is required for self-signing.");
  return { certificateSha256, keychain };
}

export function validateSelfSignedMode(
  platform: string,
  signed: boolean,
  selfSigned: boolean,
): void {
  if (!selfSigned) return;
  if (platform !== "mac") throw new Error("Self-signing is supported only for macOS.");
  if (signed) throw new Error("--signed and --mac-self-signed are mutually exclusive.");
}

export function selectPinnedCertificate(
  pem: string,
  fingerprint: string,
  now = Date.now(),
): NodeCrypto.X509Certificate {
  const expected = normalizeCertificateFingerprint(fingerprint);
  const certificates =
    pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const certificate = certificates
    .map((value) => new NodeCrypto.X509Certificate(value))
    .find((candidate) => normalizeCertificateFingerprint(candidate.fingerprint256) === expected);
  if (!certificate) throw new Error("The pinned signing certificate was not found.");
  if (certificate.ca || !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.3"))
    throw new Error("A non-CA code-signing certificate is required.");
  if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey))
    throw new Error("The pinned certificate must be self-signed.");
  if (now < Date.parse(certificate.validFrom))
    throw new Error("The pinned signing certificate is not yet valid.");
  if (now >= Date.parse(certificate.validTo))
    throw new Error("The pinned signing certificate has expired.");
  return certificate;
}

export function certificateRequirement(certificate: NodeCrypto.X509Certificate): string {
  return `certificate leaf = H"${certificate.fingerprint.replaceAll(":", "")}"`;
}

export function certificateExtractionArgs(app: string, prefix: string): string[] {
  // codesign's optional long-option arguments must use --name=value.
  return ["--display", `--extract-certificates=${prefix}`, app];
}

export function signatureVerificationArgs(
  app: string,
  certificate: NodeCrypto.X509Certificate,
): string[] {
  const requirement = `identifier "com.t3tools.t3code" and ${certificateRequirement(certificate)}`;
  // A leading '=' distinguishes literal requirement text from a file path.
  return [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    "--test-requirement",
    `=${requirement}`,
    app,
  ];
}

export function runMacCommand(command: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

export function verifyMacAppSignature(app: string, certificateSha256: string) {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mac-signature-"));
  try {
    const prefix = NodePath.join(scratch, "certificate");
    runMacCommand("codesign", certificateExtractionArgs(app, prefix));
    const leaf = new NodeCrypto.X509Certificate(NodeFS.readFileSync(`${prefix}0`));
    const certificate = selectPinnedCertificate(leaf.toString(), certificateSha256);
    runMacCommand("codesign", signatureVerificationArgs(app, certificate));
    return {
      certificateSha256: normalizeCertificateFingerprint(certificate.fingerprint256),
      certificateSubject: certificate.subject,
      certificateValidUntil: new Date(certificate.validTo).toISOString(),
      appIdentifier: "com.t3tools.t3code",
      signatureVerified: true,
      notarized: false,
    };
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}
