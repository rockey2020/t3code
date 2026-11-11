// @effect-diagnostics nodeBuiltinImport:off - A custom signing hook pins the certificate without changing system trust.
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import {
  resolveMacSelfSignedEnvironment,
  runMacCommand,
  selectPinnedCertificate,
  verifyMacAppSignature,
} from "./lib/mac-self-signing.ts";

export default async function sign(options: SignOptions): Promise<void> {
  const { keychain, certificateSha256 } = resolveMacSelfSignedEnvironment(process.env);
  const certificate = selectPinnedCertificate(
    runMacCommand("security", ["find-certificate", "-a", "-p", keychain]),
    certificateSha256,
  );
  await signApplication({
    ...options,
    identity: certificate.fingerprint.replaceAll(":", ""),
    keychain,
    identityValidation: false,
    strictVerify: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    batchCodesignCalls: true,
    optionsForFile: (file, context) => ({
      ...options.optionsForFile?.(file, context),
      hardenedRuntime: true,
      timestamp: "none",
    }),
  });
  verifyMacAppSignature(options.app, certificateSha256);
}
