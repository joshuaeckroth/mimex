import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const runtimeRoot = path.join(desktopRoot, "runtime");
const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
const runtimePackageJsonPath = path.join(runtimeRoot, "package.json");
const apiPackageJsonPath = path.join(repoRoot, "apps", "api", "package.json");

const requiredPaths = [
  path.join(repoRoot, "apps", "api", "dist", "server.js"),
  path.join(repoRoot, "apps", "web", "dist", "index.html"),
  path.join(repoRoot, "packages", "core", "dist", "index.js"),
  path.join(repoRoot, "packages", "shared-types", "dist", "index.js")
];

for (const requiredPath of requiredPaths) {
  try {
    await access(requiredPath);
  } catch {
    throw new Error(`Missing required build artifact: ${requiredPath}`);
  }
}

assertSafeRuntimeRoot(runtimeRoot, desktopRoot);
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

await cp(path.join(repoRoot, "apps", "api", "dist"), path.join(runtimeRoot, "apps", "api", "dist"), { recursive: true });
await cp(path.join(repoRoot, "apps", "web", "dist"), path.join(runtimeRoot, "apps", "web", "dist"), { recursive: true });
await mkdir(path.join(runtimeRoot, "apps", "web", "scripts"), { recursive: true });
await cp(path.join(repoRoot, "apps", "web", "scripts", "server.mjs"), path.join(runtimeRoot, "apps", "web", "scripts", "server.mjs"));

const apiPackageJson = JSON.parse(await readFile(apiPackageJsonPath, "utf8"));
const runtimeDependencies = extractExternalDependencies(apiPackageJson.dependencies ?? {});

await writeFile(
  runtimePackageJsonPath,
  `${JSON.stringify(
    {
      name: "@mimex/desktop-runtime",
      private: true,
      type: "module",
      dependencies: runtimeDependencies
    },
    null,
    2
  )}\n`,
  "utf8"
);

// Install runtime deps without pnpm symlinks; this avoids EPERM on Windows.
await runCommand("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], runtimeRoot);

await writeWorkspaceRuntimePackage({
  name: "@mimex/shared-types",
  sourceDir: path.join(repoRoot, "packages", "shared-types")
});

await writeWorkspaceRuntimePackage({
  name: "@mimex/core",
  sourceDir: path.join(repoRoot, "packages", "core")
});

process.stdout.write(`Prepared desktop runtime at ${runtimeRoot}\n`);

async function writeWorkspaceRuntimePackage({ name, sourceDir }) {
  const packageJsonPath = path.join(sourceDir, "package.json");
  const packageRaw = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const targetDir = path.join(runtimeNodeModules, ...name.split("/"));

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await cp(path.join(sourceDir, "dist"), path.join(targetDir, "dist"), { recursive: true });

  const runtimePackageJson = {
    name: packageRaw.name,
    version: packageRaw.version,
    private: true,
    type: packageRaw.type ?? "module",
    main: "dist/index.js",
    exports: {
      ".": "./dist/index.js"
    }
  };

  await writeFile(path.join(targetDir, "package.json"), `${JSON.stringify(runtimePackageJson, null, 2)}\n`, "utf8");
}

function assertSafeRuntimeRoot(targetPath, expectedParent) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.resolve(expectedParent);
  const expectedRuntimeRoot = path.join(resolvedParent, "runtime");

  if (resolvedTarget !== expectedRuntimeRoot) {
    throw new Error(`Refusing to clean unexpected runtime path: ${resolvedTarget}`);
  }

  if (path.basename(resolvedTarget) !== "runtime") {
    throw new Error(`Refusing to clean path with unexpected basename: ${resolvedTarget}`);
  }
}

function extractExternalDependencies(dependencies) {
  const result = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== "string") {
      continue;
    }
    if (version.startsWith("workspace:")) {
      continue;
    }
    result[name] = version;
  }
  return result;
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by signal ${signal}`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}
