import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const args = process.argv.slice(2);
const argMap = Object.fromEntries(
  args
    .filter((arg) => arg.startsWith("--") && arg.includes("="))
    .map((arg) => {
      const [k, v] = arg.slice(2).split("=");
      return [k, v];
    })
);

const rootName = argMap.root ?? "src";
const port = Number(argMap.port ?? process.env.PORT ?? 5173);
const host = process.env.HOST ?? "127.0.0.1";
const apiOrigin = process.env.API_ORIGIN ?? "http://127.0.0.1:8080";
const staticRoot = path.resolve(root, rootName);

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

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^\/+/, "");
  return normalized;
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

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

  if (!(await fileExists(requested))) {
    requested = path.join(staticRoot, "index.html");
  }

  const rel = path.relative(staticRoot, requested);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
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

server.listen(port, host, () => {
  process.stdout.write(`web server running at http://${host}:${port} (root=${rootName}, api=${apiOrigin})\n`);
});
