import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { app, BrowserWindow, dialog } from "electron";

const API_PORT = Number(process.env.MIMEX_DESKTOP_API_PORT ?? "8080");
const WEB_PORT = Number(process.env.MIMEX_DESKTOP_WEB_PORT ?? "4173");
const STARTUP_TIMEOUT_MS = 20_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, "runtime") : await findRepoRoot(here);
const apiEntry = path.join(runtimeRoot, "apps", "api", "dist", "server.js");
const webEntry = path.join(runtimeRoot, "apps", "web", "scripts", "server.mjs");
const webIndex = path.join(runtimeRoot, "apps", "web", "dist", "index.html");

const services = [];
let shuttingDown = false;

function serviceLog(name, message) {
  process.stdout.write(`[desktop:${name}] ${message}\n`);
}

function spawnService(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: runtimeRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  services.push({ name, child });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      serviceLog(name, text);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      serviceLog(name, text);
    }
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    dialog.showErrorBox("Mimex Desktop", `${name} process stopped unexpectedly (${reason}).`);
    void app.quit();
  });

  return child;
}

function stopServices() {
  shuttingDown = true;

  for (const { child } of services) {
    if (!child.killed) {
      child.kill();
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      await wait(250);
    }
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

  spawnService("api", process.execPath, [apiEntry], {
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    MIMEX_WORKSPACE_ROOT: workspaceRoot
  });
  await waitForHttp(`http://127.0.0.1:${API_PORT}/healthz`, STARTUP_TIMEOUT_MS);

  spawnService("web", process.execPath, [webEntry, "--root=dist", `--port=${WEB_PORT}`], {
    HOST: "127.0.0.1",
    API_ORIGIN: `http://127.0.0.1:${API_PORT}`
  });
  await waitForHttp(`http://127.0.0.1:${WEB_PORT}/healthz`, STARTUP_TIMEOUT_MS);
}

async function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  await mainWindow.loadURL(`http://127.0.0.1:${WEB_PORT}`);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void app.quit();
  }
});

app.on("before-quit", () => {
  stopServices();
});

app.on("quit", () => {
  stopServices();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});

process.on("SIGINT", () => {
  stopServices();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopServices();
  process.exit(0);
});

try {
  await app.whenReady();
  await startServices();
  await createMainWindow();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("Mimex Desktop", message);
  stopServices();
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
