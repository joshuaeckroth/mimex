import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const cacheDir = path.join(desktopRoot, ".cache", "electron-builder");

await mkdir(cacheDir, { recursive: true });

const child = spawn(
  "pnpm",
  ["exec", "electron-builder", "--win", "nsis", "--config.win.signAndEditExecutable=false"],
  {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: cacheDir
    },
    stdio: "inherit",
    shell: process.platform === "win32"
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`electron-builder terminated by signal: ${signal}\n`);
    process.exit(1);
    return;
  }

  process.exit(code ?? 1);
});
