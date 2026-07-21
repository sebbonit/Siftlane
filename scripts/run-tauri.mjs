#!/usr/bin/env node
// Cross-platform tauri launcher. On macOS, wraps rustc so local debug
// binaries can be codesigned; other platforms invoke tauri unchanged.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };

if (process.platform === "darwin") {
  env.RUSTC_WRAPPER = path.join(root, "scripts", "sign-macos-dev-binary.sh");
}

const result = spawnSync("tauri", process.argv.slice(2), {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
