/* oxlint-disable t3code/no-global-process-runtime -- Native installer verification is a standalone macOS command. */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Release verification operates on native installer files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  normalizeCertificateFingerprint,
  runMacCommand,
  verifyMacAppSignature,
} from "./lib/mac-self-signing.ts";

export function selectMacReleaseArchives(names: readonly string[]): string[] {
  const archives = names.filter((name) => /-arm64\.(dmg|zip)$/.test(name)).sort();
  if (
    archives.length !== 2 ||
    !archives.some((name) => name.endsWith(".dmg")) ||
    !archives.some((name) => name.endsWith(".zip"))
  ) {
    throw new Error("Exactly one macOS ARM64 DMG and one ZIP must be verified.");
  }
  if (archives[0]!.replace(/\.(dmg|zip)$/, "") !== archives[1]!.replace(/\.(dmg|zip)$/, ""))
    throw new Error("The DMG and ZIP must have the same release name.");
  return archives;
}

export function findReleaseApp(directory: string): string {
  const apps = NodeFS.readdirSync(directory).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("An archive must contain exactly one application.");
  const app = NodePath.join(directory, apps[0]!);
  if (!NodeFS.lstatSync(app).isDirectory())
    throw new Error("The application must be a real directory, not a symlink.");
  return app;
}

async function hashFile(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyMacReleaseArtifacts(directory: string, fingerprint: string) {
  if (NodeOS.platform() !== "darwin")
    throw new Error("Installer signature verification requires macOS.");
  const certificateSha256 = normalizeCertificateFingerprint(fingerprint);
  const archives = selectMacReleaseArchives(NodeFS.readdirSync(directory));
  const artifacts = [];
  for (const name of archives) {
    const artifact = NodePath.resolve(directory, name);
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mac-release-verify-"));
    const extracted = NodePath.join(scratch, "app");
    NodeFS.mkdirSync(extracted);
    let mounted = false;
    try {
      if (name.endsWith(".dmg")) {
        runMacCommand("hdiutil", [
          "attach",
          "-nobrowse",
          "-readonly",
          "-mountpoint",
          extracted,
          artifact,
        ]);
        mounted = true;
      } else {
        runMacCommand("ditto", ["-x", "-k", artifact, extracted]);
      }
      const signature = verifyMacAppSignature(findReleaseApp(extracted), certificateSha256);
      artifacts.push({
        name: NodePath.basename(artifact),
        sha256: await hashFile(artifact),
        ...signature,
      });
    } finally {
      if (mounted) runMacCommand("hdiutil", ["detach", extracted]);
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return {
    schemaVersion: 1,
    signing: "self-signed",
    certificateSha256,
    notarized: false,
    artifacts,
  };
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "artifacts-dir": { type: "string", default: "release" },
      output: { type: "string", default: "release/macos-signing.json" },
    },
  });
  const output = NodePath.resolve(values.output);
  NodeFS.rmSync(output, { force: true });
  const manifest = await verifyMacReleaseArtifacts(
    NodePath.resolve(values["artifacts-dir"]),
    process.env.T3CODE_MAC_SIGN_CERT_SHA256 ?? "",
  );
  NodeFS.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Both macOS installers passed strict signature and fixed certificate verification.");
}
