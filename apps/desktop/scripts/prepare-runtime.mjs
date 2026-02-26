import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const runtimeRoot = path.join(desktopRoot, "runtime");
const runtimeNodeModules = path.join(runtimeRoot, "node_modules");

const requiredPaths = [
  path.join(repoRoot, "apps", "api", "dist", "server.js"),
  path.join(repoRoot, "apps", "web", "dist", "index.html"),
  path.join(repoRoot, "packages", "core", "dist", "index.js"),
  path.join(repoRoot, "packages", "shared-types", "dist", "index.js"),
  path.join(repoRoot, "node_modules")
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
await cp(path.join(repoRoot, "node_modules"), runtimeNodeModules, { recursive: true });

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
