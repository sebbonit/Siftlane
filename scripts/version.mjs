import fs from "node:fs";

const [command = "check", requestedVersion] = process.argv.slice(2);
const packagePath = "package.json";
const tauriPath = "src-tauri/tauri.conf.json";
const cargoPath = "Cargo.toml";
const lockPath = "Cargo.lock";

const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const tauriJson = JSON.parse(fs.readFileSync(tauriPath, "utf8"));
const cargoText = fs.readFileSync(cargoPath, "utf8");
const cargoVersion = cargoText.match(/\[workspace\.package\]\s+version = "([^"]+)"/)?.[1];

if (!cargoVersion) {
  throw new Error("Could not read workspace.package.version from Cargo.toml");
}

if (command === "check") {
  const versions = new Map([
    [packagePath, packageJson.version],
    [tauriPath, tauriJson.version],
    [cargoPath, cargoVersion],
  ]);
  const unique = new Set(versions.values());
  if (unique.size !== 1) {
    throw new Error(
      `Version metadata disagrees:\n${[...versions].map(([file, version]) => `- ${file}: ${version}`).join("\n")}`,
    );
  }
  process.stdout.write(`Version metadata is consistent at ${packageJson.version}.\n`);
} else if (command === "set") {
  if (!requestedVersion || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
    throw new Error("Usage: node scripts/version.mjs set <semver>");
  }
  packageJson.version = requestedVersion;
  tauriJson.version = requestedVersion;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(tauriPath, `${JSON.stringify(tauriJson, null, 2)}\n`);
  fs.writeFileSync(
    cargoPath,
    cargoText.replace(
      /(\[workspace\.package\]\s+version = ")[^"]+(")/,
      `$1${requestedVersion}$2`,
    ),
  );
  if (fs.existsSync(lockPath)) {
    const lockText = fs.readFileSync(lockPath, "utf8");
    const workspacePackages = ["siftlane-app", "siftlane-core", "siftlane-ftp", "siftlane-sftp"];
    const updatedLock = workspacePackages.reduce(
      (text, name) =>
        text.replace(
          new RegExp(`(name = "${name}"\\nversion = ")[^"]+(")`),
          `$1${requestedVersion}$2`,
        ),
      lockText,
    );
    fs.writeFileSync(lockPath, updatedLock);
  }
  process.stdout.write(`Synchronized build metadata to ${requestedVersion}.\n`);
} else {
  throw new Error(`Unknown command "${command}". Use check or set.`);
}
