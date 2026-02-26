import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function parseArgMap(args) {
  return Object.fromEntries(
    args
      .filter((arg) => arg.startsWith("--") && arg.includes("="))
      .map((arg) => {
        const [k, v] = arg.slice(2).split("=");
        return [k, v];
      })
  );
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  return path.normalize(decoded).replace(/^\/+/, "");
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

export function createWebServer(options = {}) {
  const rootName = options.rootName ?? "src";
  const port = Number(options.port ?? process.env.PORT ?? 5173);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const apiOrigin = options.apiOrigin ?? process.env.API_ORIGIN ?? "http://127.0.0.1:8080";
  const staticRoot = path.resolve(root, rootName);
  const nodeModulesRoot = path.join(root, "node_modules");
  const vendorFallbackMap = {
    "vendor/markdown-it.min.js": path.join(nodeModulesRoot, "markdown-it", "dist", "markdown-it.min.js"),
    "vendor/purify.min.js": path.join(nodeModulesRoot, "dompurify", "dist", "purify.min.js"),
    "vendor/highlight.min.js": path.join(nodeModulesRoot, "@highlightjs", "cdn-assets", "highlight.min.js")
  };

  function proxyToApi(req, res) {
    const target = new URL(req.url, apiOrigin);
    const reqFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = reqFn(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...req.headers,
          host: target.host
        }
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      }
    );

    outgoing.on("error", (error) => {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `API proxy failed: ${error.message}` }));
    });

    req.pipe(outgoing);
  }

  async function serveStatic(req, res) {
    const normalized = safePath(req.url ?? "/");
    let requested = path.join(staticRoot, normalized || "index.html");
    let usingVendorFallback = false;

    if (!(await fileExists(requested))) {
      const vendorFallback = vendorFallbackMap[normalized];
      if (vendorFallback && (await fileExists(vendorFallback))) {
        requested = vendorFallback;
        usingVendorFallback = true;
      } else {
        requested = path.join(staticRoot, "index.html");
      }
    }

    const rel = path.relative(staticRoot, requested);
    if (!usingVendorFallback && (rel.startsWith("..") || path.isAbsolute(rel))) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const ext = path.extname(requested).toLowerCase();
    const mime = mimeByExt[ext] ?? "application/octet-stream";
    const file = await readFile(requested);
    res.writeHead(200, {
      "content-type": mime,
      "cache-control": "no-cache"
    });
    res.end(file);
  }

  const server = createServer((req, res) => {
    const urlPath = req.url ?? "/";
    if (urlPath.startsWith("/api/") || urlPath === "/healthz") {
      proxyToApi(req, res);
      return;
    }

    void serveStatic(req, res);
  });

  return {
    server,
    host,
    port,
    rootName,
    apiOrigin
  };
}

export function startWebServer(options = {}) {
  const instance = createWebServer(options);
  return new Promise((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(instance.port, instance.host, () => {
      process.stdout.write(
        `web server running at http://${instance.host}:${instance.port} (root=${instance.rootName}, api=${instance.apiOrigin})\n`
      );
      resolve(instance.server);
    });
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const argMap = parseArgMap(process.argv.slice(2));
  const rootName = argMap.root ?? "src";
  const port = Number(argMap.port ?? process.env.PORT ?? 5173);

  startWebServer({ rootName, port }).catch((error) => {
    process.stderr.write(`web server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
