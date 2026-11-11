export function validateMacSigningManifest(config, manifest, artifactHashes) {
  const fingerprint = config.certificateSha256;
  if (config.mode !== "self-signed" || !/^[0-9A-F]{64}$/.test(fingerprint)) {
    throw new Error("A fixed self-signed macOS certificate must be configured.");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.signing !== "self-signed" ||
    manifest.notarized !== false ||
    manifest.certificateSha256 !== fingerprint ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error("Invalid macOS signing verification manifest.");
  }
  const names = Object.keys(artifactHashes).filter((name) => /-arm64\.(?:dmg|zip)$/.test(name));
  if (
    names.length !== 2 ||
    !names.some((name) => name.endsWith(".dmg")) ||
    !names.some((name) => name.endsWith(".zip")) ||
    manifest.artifacts.length !== names.length
  ) {
    throw new Error("Both macOS DMG and ZIP must have a verified fixed signature.");
  }
  for (const name of names) {
    const matching = manifest.artifacts.filter((artifact) => artifact.name === name);
    const artifact = matching[0];
    if (
      matching.length !== 1 ||
      artifact.signatureVerified !== true ||
      artifact.certificateSha256 !== fingerprint ||
      artifact.notarized !== false ||
      artifact.appIdentifier !== "com.t3tools.t3code" ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      artifact.sha256 !== artifactHashes[name]
    ) {
      throw new Error(`Missing or mismatched fixed macOS signature verification: ${name}`);
    }
  }
  return { type: "self-signed", certificateSha256: fingerprint, notarized: false };
}
