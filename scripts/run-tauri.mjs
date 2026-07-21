#!/usr/bin/env node
// Cross-platform tauri launcher. On macOS, wraps rustc so local debug
// binaries can be codesigned; other platforms invoke tauri unchanged.
// Spawn the CLI via node (no shell) so JSON --config args survive on Windows.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };

if (process.platform === "darwin") {
  env.RUSTC_WRAPPER = path.join(root, "scripts", "sign-macos-dev-binary.sh");
}

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const result = spawnSync(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
