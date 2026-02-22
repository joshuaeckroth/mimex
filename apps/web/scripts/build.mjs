import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const nodeModulesDir = path.join(root, "node_modules");

const vendorFiles = [
  {
    source: path.join(nodeModulesDir, "markdown-it", "dist", "markdown-it.min.js"),
    target: path.join(distDir, "vendor", "markdown-it.min.js")
  },
  {
    source: path.join(nodeModulesDir, "dompurify", "dist", "purify.min.js"),
    target: path.join(distDir, "vendor", "purify.min.js")
  },
  {
    source: path.join(nodeModulesDir, "@highlightjs", "cdn-assets", "highlight.min.js"),
    target: path.join(distDir, "vendor", "highlight.min.js")
  }
];

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(srcDir, distDir, { recursive: true });

for (const file of vendorFiles) {
  await mkdir(path.dirname(file.target), { recursive: true });
  await cp(file.source, file.target);
}

process.stdout.write(`Built web app to ${distDir}\n`);
