const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const process = require("node:process");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");

const API_PORT = Number(process.env.MIMEX_DESKTOP_API_PORT ?? "8080");
const WEB_PORT = Number(process.env.MIMEX_DESKTOP_WEB_PORT ?? "4173");
const STARTUP_TIMEOUT_MS = 20_000;

app.disableHardwareAcceleration();

const here = __dirname;
const runtimeRoot = app.isPackaged ? resolvePackagedRuntimeRoot(here) : findRepoRootSync(here);
const apiEntry = path.join(runtimeRoot, "apps", "api", "dist", "server.js");
const webEntry = path.join(runtimeRoot, "apps", "web", "scripts", "server.mjs");
const webIndex = path.join(runtimeRoot, "apps", "web", "dist", "index.html");

let shuttingDown = false;
let servicesReady = false;
let mainWindow = null;
let apiModule = null;
let webServer = null;
let logFilePath = null;
let apiPort = API_PORT;
let webPort = WEB_PORT;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

const KEYCHAIN_SERVICE = "mimex/git";
let keytar = null;
try {
  // Optional dependency in dev; required for packaged desktop token storage.
  keytar = require("keytar");
} catch {
  keytar = null;
}

const bootstrapLogPath = path.join(process.env.LOCALAPPDATA ?? process.cwd(), "Mimex", "bootstrap.log");
bootstrapLog(`process start (pid=${process.pid})`);
bootstrapLog(`runtimeRoot=${runtimeRoot}`);

function bootstrapLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(bootstrapLogPath), { recursive: true });
    fs.appendFileSync(bootstrapLogPath, line, "utf8");
  } catch {
    // ignore bootstrap logging failures
  }
}

function registerKeychainIpc() {
  ipcMain.handle("mimex:keychain:get-token", async (_event, tokenRef) => {
    if (!keytar) {
      return null;
    }
    const account = String(tokenRef ?? "").trim();
    if (!account) {
      return null;
    }
    const value = await keytar.getPassword(KEYCHAIN_SERVICE, account);
    return value ?? null;
  });

  ipcMain.handle("mimex:keychain:set-token", async (_event, payload) => {
    if (!keytar) {
      throw new Error("System keychain is unavailable in this build.");
    }
    const account = String(payload?.tokenRef ?? "").trim();
    const token = String(payload?.token ?? "").trim();
    if (!account) {
      throw new Error("tokenRef is required");
    }
    if (!token) {
      throw new Error("token is required");
    }
    await keytar.setPassword(KEYCHAIN_SERVICE, account, token);
    return { ok: true };
  });

  ipcMain.handle("mimex:keychain:delete-token", async (_event, tokenRef) => {
    if (!keytar) {
      return { ok: true };
    }
    const account = String(tokenRef ?? "").trim();
    if (!account) {
      return { ok: true };
    }
    await keytar.deletePassword(KEYCHAIN_SERVICE, account);
    return { ok: true };
  });
}

function asErrorMessage(value) {
  if (value instanceof Error) {
    return `${value.message}\n${value.stack ?? ""}`.trim();
  }
  return String(value);
}

function isAbortNavigationError(value) {
  const message = asErrorMessage(value);
  return message.includes("(-3)") || message.includes("ERR_ABORTED");
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  bootstrapLog(message);
  if (logFilePath) {
    void fsp.appendFile(logFilePath, line, "utf8").catch(() => {
      // ignore logging failures
    });
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkHttp(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const statusCode = res.statusCode ?? 500;
      res.resume();
      if (statusCode >= 200 && statusCode < 500) {
        resolve();
        return;
      }
      reject(new Error(`Unexpected status ${statusCode}`));
    });

    req.setTimeout(1_000, () => {
      req.destroy(new Error("timed out"));
    });

    req.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await checkHttp(url);
      return;
    } catch {
      // retry
    }
    await wait(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const tester = http
      .createServer()
      .once("error", (error) => {
        const code = error?.code;
        resolve(code === "EADDRINUSE" || code === "EACCES");
      })
      .once("listening", () => {
        tester.close(() => resolve(false));
      })
      .listen(port, host);
  });
}

function findEphemeralPort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const tester = http.createServer();
    tester.once("error", reject);
    tester.listen(0, host, () => {
      const address = tester.address();
      const port = typeof address === "object" && address ? address.port : 0;
      tester.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function assertRequiredFiles() {
  try {
    await fsp.access(apiEntry);
  } catch {
    throw new Error(`API build output missing: ${apiEntry}`);
  }

  try {
    await fsp.access(webIndex);
  } catch {
    throw new Error(`Web build output missing: ${webIndex}`);
  }
}

async function startServices() {
  log("startServices: validating runtime files");
  await assertRequiredFiles();

  const defaultWorkspaceRoot = app.isPackaged
    ? path.join(app.getPath("userData"), "workspaces")
    : path.join(runtimeRoot, "data", "workspaces");
  const workspaceRoot = process.env.MIMEX_WORKSPACE_ROOT ?? defaultWorkspaceRoot;

  log(`startServices: workspaceRoot=${workspaceRoot}`);

  if (!process.env.MIMEX_DESKTOP_API_PORT && (await isPortInUse(apiPort))) {
    const fallbackApiPort = await findEphemeralPort();
    log(`startServices: api port ${apiPort} in use, switching to ${fallbackApiPort}`);
    apiPort = fallbackApiPort;
  }

  if (!process.env.MIMEX_DESKTOP_WEB_PORT && (await isPortInUse(webPort))) {
    const fallbackWebPort = await findEphemeralPort();
    log(`startServices: web port ${webPort} in use, switching to ${fallbackWebPort}`);
    webPort = fallbackWebPort;
  }

  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(apiPort);
  process.env.MIMEX_WORKSPACE_ROOT = workspaceRoot;

  log(`startServices: importing API module ${apiEntry}`);
  apiModule = await import(pathToFileURL(apiEntry).href);
  if (typeof apiModule.start !== "function") {
    throw new Error("API module is missing start()");
  }
  log("startServices: starting API");
  await apiModule.start();
  await waitForHttp(`http://127.0.0.1:${apiPort}/healthz`, STARTUP_TIMEOUT_MS);

  log(`startServices: importing Web module ${webEntry}`);
  const webModule = await import(pathToFileURL(webEntry).href);
  if (typeof webModule.startWebServer !== "function") {
    throw new Error("Web module is missing startWebServer()");
  }

  log("startServices: starting Web server");
  webServer = await webModule.startWebServer({
    host: "127.0.0.1",
    port: webPort,
    rootName: "dist",
    apiOrigin: `http://127.0.0.1:${apiPort}`
  });
  await waitForHttp(`http://127.0.0.1:${webPort}/healthz`, STARTUP_TIMEOUT_MS);
  servicesReady = true;
  log("startServices: services are ready");
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

function startupErrorHtml(message) {
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Mimex Startup Error</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Segoe UI, Tahoma, sans-serif;
        background: #fff7f7;
        color: #111827;
        padding: 16px;
      }
      .card {
        width: min(840px, 100%);
        background: white;
        border: 1px solid #fecaca;
        border-radius: 12px;
        padding: 20px 24px;
      }
      h1 {
        margin: 0 0 10px 0;
        font-size: 20px;
        color: #b91c1c;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 12px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Mimex failed to start</h1>
      <p>See logs at:</p>
      <pre>${bootstrapLogPath}${logFilePath ? `\n${logFilePath}` : ""}</pre>
      <pre>${safe}</pre>
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
    backgroundColor: "#f5f7fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (shuttingDown) {
      return;
    }
    if (errorCode === -3) {
      return;
    }
    log(`did-fail-load: ${errorCode} ${errorDescription} ${validatedURL ?? ""}`.trim());
  });

  void window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(loadingPageHtml())}`).catch((error) => {
    if (!isAbortNavigationError(error)) {
      log(`loading screen failed: ${asErrorMessage(error)}`);
    }
  });
  window.show();
  window.focus();
  return window;
}

async function loadMainUi(window) {
  const targetUrl = `http://127.0.0.1:${webPort}`;
  try {
    await window.loadURL(targetUrl);
    return;
  } catch (error) {
    if (!isAbortNavigationError(error)) {
      throw error;
    }
  }

  // Data URL loading screen can be aborted by the real UI navigation.
  if (window.webContents.getURL().startsWith(targetUrl)) {
    return;
  }

  await wait(150);
  await window.loadURL(targetUrl);
}

async function showStartupError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }

  await mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(startupErrorHtml(message))}`);
  mainWindow.show();
  mainWindow.focus();
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

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
});

process.on("uncaughtException", (error) => {
  const message = asErrorMessage(error);
  log(`uncaughtException: ${message}`);
  void showStartupError(message);
});

process.on("unhandledRejection", (reason) => {
  const message = asErrorMessage(reason);
  log(`unhandledRejection: ${message}`);
  void showStartupError(message);
});

async function boot() {
  await app.whenReady();
  registerKeychainIpc();
  const logsDir = path.join(app.getPath("userData"), "logs");
  await fsp.mkdir(logsDir, { recursive: true });
  logFilePath = path.join(logsDir, "main.log");
  log("app ready");
  log(`appPath=${app.getAppPath()}`);
  log(`runtimeRoot=${runtimeRoot}`);

  mainWindow = createMainWindow();
  log("main window created");

  try {
    await startServices();
    log("loading main UI");
    await loadMainUi(mainWindow);
    log("main UI loaded");
  } catch (error) {
    const message = asErrorMessage(error);
    log(`startup failure: ${message}`);
    await showStartupError(message);
    await stopServices();
  }
}

void boot();

function findRepoRootSync(startDir) {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve repo root from desktop app location.");
    }
    current = parent;
  }
}

function resolvePackagedRuntimeRoot(currentDir) {
  const candidates = [
    path.join(process.resourcesPath, "runtime"),
    path.resolve(currentDir, "..", "runtime")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "apps", "api", "dist", "server.js"))) {
      return candidate;
    }
  }

  return candidates[0];
}
