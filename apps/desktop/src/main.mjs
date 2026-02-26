import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog } from "electron";

const API_PORT = Number(process.env.MIMEX_DESKTOP_API_PORT ?? "8080");
const WEB_PORT = Number(process.env.MIMEX_DESKTOP_WEB_PORT ?? "4173");
const STARTUP_TIMEOUT_MS = 20_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, "runtime") : await findRepoRoot(here);
const apiEntry = path.join(runtimeRoot, "apps", "api", "dist", "server.js");
const webEntry = path.join(runtimeRoot, "apps", "web", "scripts", "server.mjs");
const webIndex = path.join(runtimeRoot, "apps", "web", "dist", "index.html");

let shuttingDown = false;
let servicesReady = false;
let mainWindow = null;
let apiModule = null;
let webServer = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // retry
    }

    await wait(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function assertRequiredFiles() {
  try {
    await access(apiEntry);
  } catch {
    throw new Error("API build output missing. Run: pnpm --filter @mimex/api build");
  }

  try {
    await access(webIndex);
  } catch {
    throw new Error("Web build output missing. Run: pnpm --filter @mimex/web build");
  }
}

async function startServices() {
  await assertRequiredFiles();

  const defaultWorkspaceRoot = app.isPackaged
    ? path.join(app.getPath("userData"), "workspaces")
    : path.join(runtimeRoot, "data", "workspaces");
  const workspaceRoot = process.env.MIMEX_WORKSPACE_ROOT ?? defaultWorkspaceRoot;

  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(API_PORT);
  process.env.MIMEX_WORKSPACE_ROOT = workspaceRoot;

  apiModule = await import(pathToFileURL(apiEntry).href);
  if (typeof apiModule.start !== "function") {
    throw new Error("API module is missing start()");
  }
  await apiModule.start();
  await waitForHttp(`http://127.0.0.1:${API_PORT}/healthz`, STARTUP_TIMEOUT_MS);

  const webModule = await import(pathToFileURL(webEntry).href);
  if (typeof webModule.startWebServer !== "function") {
    throw new Error("Web module is missing startWebServer()");
  }

  webServer = await webModule.startWebServer({
    host: "127.0.0.1",
    port: WEB_PORT,
    rootName: "dist",
    apiOrigin: `http://127.0.0.1:${API_PORT}`
  });
  await waitForHttp(`http://127.0.0.1:${WEB_PORT}/healthz`, STARTUP_TIMEOUT_MS);
  servicesReady = true;
}

async function stopServices() {
  shuttingDown = true;

  if (webServer) {
    const serverToClose = webServer;
    webServer = null;
    await new Promise((resolve) => {
      serverToClose.close(() => resolve());
    });
  }

  if (apiModule?.app?.close) {
    try {
      await apiModule.app.close();
    } catch {
      // ignore shutdown errors
    }
  }
}

function loadingPageHtml() {
  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Mimex</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Segoe UI, Tahoma, sans-serif;
        background: #f5f7fa;
        color: #1f2937;
      }
      .card {
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        padding: 20px 24px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.07);
      }
      .title {
        margin: 0 0 8px 0;
        font-size: 18px;
        font-weight: 600;
      }
      .sub {
        margin: 0;
        font-size: 14px;
        color: #4b5563;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <p class="title">Starting Mimex...</p>
      <p class="sub">Booting local API and Web UI.</p>
    </div>
  </body>
</html>
`;
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (shuttingDown) {
      return;
    }
    dialog.showErrorBox("Mimex Desktop", `Failed to load UI (${errorCode}): ${errorDescription}`);
  });

  void window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(loadingPageHtml())}`);
  return window;
}

async function loadMainUi(window) {
  await window.loadURL(`http://127.0.0.1:${WEB_PORT}`);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void app.quit();
  }
});

app.on("before-quit", () => {
  void stopServices();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
    if (servicesReady) {
      void loadMainUi(mainWindow);
    }
  }
});

process.on("SIGINT", () => {
  void stopServices().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void stopServices().finally(() => process.exit(0));
});

try {
  await app.whenReady();
  mainWindow = createMainWindow();
  await startServices();
  await loadMainUi(mainWindow);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("Mimex Desktop", message);
  await stopServices();
  void app.quit();
}

async function findRepoRoot(startDir) {
  let current = startDir;

  while (true) {
    try {
      await access(path.join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("Could not resolve repo root from desktop app location.");
      }
      current = parent;
    }
  }
}
