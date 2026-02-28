import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const cacheDir = path.join(desktopRoot, ".cache", "electron-builder");

await mkdir(cacheDir, { recursive: true });

function runBuilder(args) {
  return spawnSync("pnpm", args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: cacheDir
    },
    stdio: "inherit",
    shell: process.platform === "win32"
  });
}

const baseArgs = ["exec", "electron-builder", "--win", "nsis"];
const skipExeEditArgs = [...baseArgs, "--config.win.signAndEditExecutable=false"];
const skipExeEdit = process.env.MIMEX_SKIP_EXE_EDIT === "1";

const first = runBuilder(skipExeEdit ? skipExeEditArgs : baseArgs);
if (first.status === 0) {
  process.exit(0);
}
if (first.signal) {
  process.stderr.write(`electron-builder terminated by signal: ${first.signal}\n`);
  process.exit(1);
}

if (!skipExeEdit && process.platform === "win32") {
  process.stderr.write(
    "electron-builder failed on Windows; retrying with signAndEditExecutable=false to bypass symlink privilege issues.\n"
  );
  const second = runBuilder(skipExeEditArgs);
  if (second.status === 0) {
    process.exit(0);
  }
  if (second.signal) {
    process.stderr.write(`electron-builder terminated by signal: ${second.signal}\n`);
    process.exit(1);
  }
  process.exit(second.status ?? 1);
}

process.exit(first.status ?? 1);
