import {
  buildHashState,
  buildListRows,
  formatEditableNoteContent,
  parseEditedNoteContent,
  parseHashState as parseHashStateFromHash,
  prependEditErrorComment
} from "./state-utils.js";

const els = {
  appShell: document.querySelector(".app-shell"),
  userId: document.querySelector("#userId"),
  searchInput: document.querySelector("#searchInput"),
  includeArchived: document.querySelector("#includeArchived"),
  refreshBtn: document.querySelector("#refreshBtn"),
  statusText: document.querySelector("#statusText"),
  statusRow: document.querySelector(".status-row"),
  noteList: document.querySelector("#noteList"),
  noteDetail: document.querySelector("#noteDetail"),
  toggleThemeBtn: document.querySelector("#toggleThemeBtn"),
  toggleWideBtn: document.querySelector("#toggleWideBtn"),
  toggleNotesBtn: document.querySelector("#toggleNotesBtn"),
  openHelpBtn: document.querySelector("#openHelpBtn"),
  openSettingsBtn: document.querySelector("#openSettingsBtn"),
  closeSidebarBtn: document.querySelector("#closeSidebarBtn"),
  sidebarBackdrop: document.querySelector("#sidebarBackdrop")
};

const KEY_THEME = "mimex:web:theme";
const KEY_WIDE = "mimex:web:wide";
const KEY_GIT_AUTO_SYNC_PREFIX = "mimex:web:auto-sync";
const AUTO_SYNC_DEFAULT_INTERVAL_MINUTES = 5;
const AUTO_SYNC_MIN_INTERVAL_MINUTES = 1;
const AUTO_SYNC_MAX_INTERVAL_MINUTES = 60;
const AUTO_SYNC_RETRY_DELAY_MS = 30_000;
const MOBILE_MEDIA = window.matchMedia("(max-width: 900px)");
const WIDE_DEFAULT_MEDIA = window.matchMedia("(min-width: 1100px)");

const state = {
  notes: [],
  searchResults: [],
  selectedNoteId: null,
  selectedNote: null,
  softLinks: [],
  includeArchived: false,
  focusPane: "notes",
  activeBodyIndex: 0,
  loading: false,
  savingBodyIds: new Set(),
  editingBodyIds: new Set(),
  bodyDrafts: new Map(),
  theme: "light",
  wide: false,
  sidebarOpen: false,
  git: {
    remoteUrl: "",
    branch: "main",
    authMode: "ssh",
    tokenRef: null,
    hasAuth: true,
    configured: false,
    autoSyncEnabled: false,
    autoSyncIntervalMs: AUTO_SYNC_DEFAULT_INTERVAL_MINUTES * 60_000,
    autoSyncLastSuccessAt: null,
    autoSyncLastError: null,
    autoSyncLastErrorAt: null
  }
};

const desktopBridge =
  typeof window.mimexDesktop === "object" && window.mimexDesktop && window.mimexDesktop.isDesktop
    ? window.mimexDesktop
    : null;

let dialogOpen = false;
let gitActionInFlight = false;
let autoSyncTimerId = null;

const HELP_SHORTCUTS = [
  { keys: "?", action: "Open help" },
  { keys: ",", action: "Open settings" },
  { keys: "/", action: "Focus search" },
  { keys: "Tab", action: "Switch focus between notes and body" },
  { keys: "Left / Right", action: "Focus notes / body pane" },
  { keys: "j or Down", action: "Move down (notes) or scroll down (body)" },
  { keys: "k or Up", action: "Move up (notes) or scroll up (body)" },
  { keys: "PageDown / PageUp", action: "Page down / up in focused pane" },
  { keys: "J / K", action: "Half-page down / up in focused pane" },
  { keys: "Ctrl+d / Ctrl+u", action: "Half-page down / up in focused pane" },
  { keys: "g / G", action: "Jump to top / bottom in focused pane" },
  { keys: "[ / ] / < / >", action: "Select previous / next body" },
  { keys: "e", action: "Edit selected body" },
  { keys: "Ctrl/Cmd+s", action: "Save while editing a body" },
  { keys: "n", action: "Create note" },
  { keys: "b", action: "Add body" },
  { keys: "f", action: "Follow link prompt" },
  { keys: "d", action: "Delete selected body (body focus)" },
  { keys: "a / r / D", action: "Archive / restore / delete selected note" },
  { keys: "x", action: "Toggle archived filter" },
  { keys: "s", action: "Refresh notes" },
  { keys: "t", action: "Toggle theme" },
  { keys: "w", action: "Toggle wide mode" },
  { keys: "Escape", action: "Blur input, cancel edit, or close mobile notes drawer" }
];

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusRow.classList.toggle("error", isError);
}

function openDialog({
  title,
  message = "",
  defaultValue = "",
  placeholder = "",
  multiline = false,
  showInput = false,
  confirmLabel = "ok",
  cancelLabel = "cancel"
}) {
  if (dialogOpen) {
    return Promise.resolve({ confirmed: false, value: "" });
  }

  dialogOpen = true;
  document.body.classList.add("dialog-open");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  return new Promise((resolve) => {
    let done = false;

    const finish = (confirmed) => {
      if (done) {
        return;
      }
      done = true;
      dialogOpen = false;
      document.body.classList.remove("dialog-open");
      document.removeEventListener("keydown", onDocumentKeydown, true);
      overlay.remove();
      previousFocus?.focus();
      resolve({
        confirmed,
        value: inputEl ? inputEl.value : ""
      });
    };

    const onDocumentKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };

    const overlay = document.createElement("div");
    overlay.className = "prompt-overlay";

    const dialog = document.createElement("div");
    dialog.className = "prompt-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", title);

    const titleEl = document.createElement("h3");
    titleEl.className = "prompt-title";
    titleEl.textContent = title;
    dialog.append(titleEl);

    if (message) {
      const messageEl = document.createElement("p");
      messageEl.className = "prompt-message";
      messageEl.textContent = message;
      dialog.append(messageEl);
    }

    let inputEl = null;
    if (showInput) {
      inputEl = multiline ? document.createElement("textarea") : document.createElement("input");
      inputEl.className = "prompt-input";
      inputEl.value = defaultValue;
      inputEl.placeholder = placeholder;

      if (!multiline) {
        inputEl.type = "text";
      } else {
        inputEl.rows = 8;
      }

      inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !multiline) {
          event.preventDefault();
          finish(true);
        }
      });
      dialog.append(inputEl);
    }

    const actions = document.createElement("div");
    actions.className = "prompt-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener("click", () => finish(false));

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "prompt-confirm";
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener("click", () => finish(true));

    actions.append(cancelBtn, confirmBtn);
    dialog.append(actions);
    overlay.append(dialog);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(false);
      }
    });

    document.addEventListener("keydown", onDocumentKeydown, true);
    document.body.append(overlay);

    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    } else {
      confirmBtn.focus();
    }
  });
}

async function promptForInput(title, options = {}) {
  const result = await openDialog({ ...options, title, showInput: true });
  if (!result.confirmed) {
    return null;
  }
  return result.value;
}

async function confirmAction(title, options = {}) {
  const result = await openDialog({ ...options, title, showInput: false });
  return result.confirmed;
}

function dedupeCaseInsensitive(values) {
  const seen = new Map();
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) {
      continue;
    }

    const folded = value.toLocaleLowerCase();
    if (!seen.has(folded)) {
      seen.set(folded, value);
    }
  }
  return [...seen.values()];
}

async function promptForMoveTarget(currentNoteId) {
  if (dialogOpen) {
    return null;
  }

  let notes = [];
  try {
    const payload = await apiFetch("/api/notes");
    notes = Array.isArray(payload) ? payload : [];
  } catch {
    notes = state.notes ?? [];
  }

  const candidates = notes.filter((note) => note && note.id !== currentNoteId && !note.archivedAt);
  if (candidates.length === 0) {
    setStatus("No target notes available", true);
    return null;
  }

  dialogOpen = true;
  document.body.classList.add("dialog-open");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  return new Promise((resolve) => {
    let done = false;
    const finish = (confirmed) => {
      if (done) {
        return;
      }
      done = true;
      dialogOpen = false;
      document.body.classList.remove("dialog-open");
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      previousFocus?.focus();
      resolve(confirmed ? input.value.trim() || null : null);
    };

    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
    };

    const overlay = document.createElement("div");
    overlay.className = "prompt-overlay";

    const dialog = document.createElement("div");
    dialog.className = "prompt-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Move Body");

    const title = document.createElement("h3");
    title.className = "prompt-title";
    title.textContent = "Move Body";

    const hint = document.createElement("p");
    hint.className = "prompt-message";
    hint.textContent = "Choose a destination note (id, title, or alias).";

    const datalistId = `move-targets-${Math.random().toString(36).slice(2, 9)}`;
    const list = document.createElement("datalist");
    list.id = datalistId;
    const refs = dedupeCaseInsensitive(
      candidates.flatMap((note) => [note.id, note.title, ...(Array.isArray(note.aliases) ? note.aliases : [])])
    );
    for (const ref of refs) {
      const option = document.createElement("option");
      option.value = ref;
      list.append(option);
    }

    const selectLabel = document.createElement("label");
    selectLabel.className = "settings-field";
    selectLabel.textContent = "Target note";

    const input = document.createElement("input");
    input.className = "prompt-input";
    input.type = "text";
    input.setAttribute("list", datalistId);
    input.placeholder = "Start typing note title or id...";
    input.value = candidates[0]?.id ?? "";
    selectLabel.append(input);

    const actions = document.createElement("div");
    actions.className = "prompt-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "cancel";
    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "prompt-confirm";
    moveBtn.textContent = "move";
    actions.append(cancelBtn, moveBtn);

    cancelBtn.addEventListener("click", () => finish(false));
    moveBtn.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(false);
      }
    });

    dialog.append(title, hint, selectLabel, actions, list);
    overlay.append(dialog);
    document.body.append(overlay);
    document.addEventListener("keydown", onKeydown, true);
    input.focus();
    input.select();
  });
}

function readPersisted(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePersisted(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

function clampAutoSyncIntervalMinutes(value) {
  if (!Number.isFinite(value)) {
    return AUTO_SYNC_DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(AUTO_SYNC_MAX_INTERVAL_MINUTES, Math.max(AUTO_SYNC_MIN_INTERVAL_MINUTES, Math.round(value)));
}

function autoSyncStorageKey(userId = getUserId()) {
  const normalized = (userId || "local").trim() || "local";
  return `${KEY_GIT_AUTO_SYNC_PREFIX}:${normalized}`;
}

function loadAutoSyncPrefsForCurrentUser() {
  const raw = readPersisted(autoSyncStorageKey());
  const defaults = {
    autoSyncEnabled: false,
    autoSyncIntervalMs: AUTO_SYNC_DEFAULT_INTERVAL_MINUTES * 60_000,
    autoSyncLastSuccessAt: null,
    autoSyncLastError: null,
    autoSyncLastErrorAt: null
  };

  if (!raw) {
    state.git = {
      ...state.git,
      ...defaults
    };
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const enabled = Boolean(parsed?.enabled);
    const intervalMinutes = clampAutoSyncIntervalMinutes(Number(parsed?.intervalMinutes));
    state.git = {
      ...state.git,
      autoSyncEnabled: enabled,
      autoSyncIntervalMs: intervalMinutes * 60_000,
      autoSyncLastSuccessAt: null,
      autoSyncLastError: null,
      autoSyncLastErrorAt: null
    };
  } catch {
    state.git = {
      ...state.git,
      ...defaults
    };
  }
}

function saveAutoSyncPrefsForCurrentUser() {
  const intervalMinutes = clampAutoSyncIntervalMinutes(state.git.autoSyncIntervalMs / 60_000);
  writePersisted(
    autoSyncStorageKey(),
    JSON.stringify({
      enabled: Boolean(state.git.autoSyncEnabled),
      intervalMinutes
    })
  );
}

function clearAutoSyncTimer() {
  if (autoSyncTimerId !== null) {
    window.clearTimeout(autoSyncTimerId);
    autoSyncTimerId = null;
  }
}

function scheduleAutoSync(delayMs) {
  clearAutoSyncTimer();
  if (!state.git.autoSyncEnabled) {
    return;
  }

  const waitMs = Math.max(5_000, Math.floor(delayMs));
  autoSyncTimerId = window.setTimeout(() => {
    autoSyncTimerId = null;
    void runAutoSyncCycle();
  }, waitMs);
}

function restartAutoSyncScheduler() {
  if (!state.git.autoSyncEnabled) {
    clearAutoSyncTimer();
    return;
  }
  scheduleAutoSync(state.git.autoSyncIntervalMs);
}

function formatAutoSyncStatus() {
  if (!state.git.autoSyncEnabled) {
    return "Automatic sync is off.";
  }

  const parts = [`Automatic sync runs every ${Math.round(state.git.autoSyncIntervalMs / 60_000)} minute(s).`];
  if (state.git.autoSyncLastSuccessAt) {
    parts.push(`Last success: ${formatDate(state.git.autoSyncLastSuccessAt)}.`);
  } else {
    parts.push("Last success: never.");
  }

  if (state.git.autoSyncLastError && state.git.autoSyncLastErrorAt) {
    parts.push(`Last error (${formatDate(state.git.autoSyncLastErrorAt)}): ${state.git.autoSyncLastError}`);
  }

  return parts.join(" ");
}

function isMobileViewport() {
  return MOBILE_MEDIA.matches;
}

function updateMobileDrawerMetrics() {
  if (!isMobileViewport() || !els.appShell || !els.toggleNotesBtn) {
    return;
  }
  const shellRect = els.appShell.getBoundingClientRect();
  const btnRect = els.toggleNotesBtn.getBoundingClientRect();
  const drawerWidth = Math.min(window.innerWidth * 0.86, 384);

  const top = Math.max(0, btnRect.bottom - shellRect.top + 6);
  let left = btnRect.left - shellRect.left;
  left = Math.max(0, Math.min(left, shellRect.width - drawerWidth));

  els.appShell.style.setProperty("--mobile-drawer-top", `${Math.round(top)}px`);
  els.appShell.style.setProperty("--mobile-drawer-left", `${Math.round(left)}px`);
}

function applyUiState() {
  document.body.dataset.theme = state.theme;

  els.appShell.classList.toggle("wide", state.wide);
  els.appShell.classList.toggle("sidebar-open", state.sidebarOpen);
  els.appShell.classList.toggle("focus-notes", state.focusPane === "notes");
  els.appShell.classList.toggle("focus-body", state.focusPane === "body");

  const mobile = isMobileViewport();
  els.toggleNotesBtn.hidden = !mobile;
  els.toggleWideBtn.hidden = mobile;
  els.closeSidebarBtn.hidden = !mobile || !state.sidebarOpen;
  els.sidebarBackdrop.hidden = !state.sidebarOpen;

  els.toggleThemeBtn.textContent = state.theme === "dark" ? "light" : "dark";
  els.toggleThemeBtn.setAttribute("aria-pressed", String(state.theme === "dark"));
  els.toggleThemeBtn.classList.toggle("active", state.theme === "dark");

  els.toggleWideBtn.textContent = state.wide ? "wide:on" : "wide:off";
  els.toggleWideBtn.setAttribute("aria-pressed", String(state.wide));
  els.toggleWideBtn.classList.toggle("active", state.wide);

  els.toggleNotesBtn.textContent = state.sidebarOpen ? "notes:hide" : "notes";
  els.toggleNotesBtn.setAttribute("aria-expanded", String(state.sidebarOpen));
  updateMobileDrawerMetrics();
}

function initUiPrefs() {
  const storedTheme = readPersisted(KEY_THEME);
  if (storedTheme === "dark" || storedTheme === "light") {
    state.theme = storedTheme;
  } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    state.theme = "dark";
  }

  const storedWide = readPersisted(KEY_WIDE);
  if (storedWide === "true") {
    state.wide = true;
  } else if (storedWide === "false") {
    state.wide = false;
  } else {
    state.wide = WIDE_DEFAULT_MEDIA.matches;
  }

  applyUiState();
}

function parseHashState() {
  return parseHashStateFromHash(window.location.hash);
}

function applyInitialHashState() {
  const hashState = parseHashState();
  if (hashState.query !== null) {
    els.searchInput.value = hashState.query;
  }
  if (hashState.includeArchived !== null) {
    els.includeArchived.checked = hashState.includeArchived;
  }
  state.includeArchived = els.includeArchived.checked;
  return hashState.noteId;
}

function writeHashState() {
  const hash = buildHashState({
    query: els.searchInput.value,
    includeArchived: els.includeArchived.checked,
    noteId: state.selectedNoteId
  });
  const next = `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(null, "", next);
  }
}

function getUserId() {
  return (els.userId.value || "local").trim() || "local";
}

function apiPath(path) {
  return path;
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-user-id", getUserId());
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(apiPath(path), {
    ...options,
    headers
  });

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const errorMessage =
      typeof payload === "object" && payload && "error" in payload
        ? JSON.stringify(payload.error)
        : String(payload || res.statusText);
    throw new Error(errorMessage);
  }

  return payload;
}

function normalizeGitSettings(payload) {
  const authMode = payload?.authMode === "https_pat" ? "https_pat" : "ssh";
  return {
    remoteUrl: typeof payload?.remoteUrl === "string" ? payload.remoteUrl : "",
    branch: typeof payload?.branch === "string" && payload.branch.trim() ? payload.branch.trim() : "main",
    authMode,
    tokenRef: typeof payload?.tokenRef === "string" && payload.tokenRef.trim() ? payload.tokenRef.trim() : null,
    hasAuth: Boolean(payload?.hasAuth),
    configured: Boolean(payload?.configured)
  };
}

function resolveTokenRef(userId) {
  const normalizedUser = (userId || "local").trim() || "local";
  return `mimex:${normalizedUser}`;
}

async function loadGitSettings() {
  const payload = await apiFetch("/api/git/settings");
  state.git = {
    ...state.git,
    ...normalizeGitSettings(payload)
  };
}

async function maybeSetDesktopToken(tokenRef, token) {
  if (!desktopBridge?.keychain?.setGitToken) {
    return;
  }
  await desktopBridge.keychain.setGitToken(tokenRef, token);
}

async function maybeGetDesktopToken(tokenRef) {
  if (!desktopBridge?.keychain?.getGitToken) {
    return null;
  }
  return desktopBridge.keychain.getGitToken(tokenRef);
}

async function maybeDeleteDesktopToken(tokenRef) {
  if (!desktopBridge?.keychain?.deleteGitToken) {
    return;
  }
  await desktopBridge.keychain.deleteGitToken(tokenRef);
}

async function apiGitFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.git.authMode === "https_pat" && desktopBridge?.keychain?.getGitToken) {
    const ref = state.git.tokenRef || resolveTokenRef(getUserId());
    const token = await maybeGetDesktopToken(ref);
    if (token) {
      headers.set("x-mimex-git-token", token);
    }
  }

  return apiFetch(path, {
    ...options,
    headers
  });
}

async function runGitAction(action, options = {}) {
  const quietSuccess = options.quietSuccess === true;
  const skipIfBusy = options.skipIfBusy === true;

  if (gitActionInFlight) {
    if (skipIfBusy) {
      return { skipped: true };
    }
    throw new Error("Another git operation is in progress.");
  }

  gitActionInFlight = true;
  try {
    const payload = await apiGitFetch(`/api/git/${action}`, { method: "POST" });
    if (payload?.status) {
      state.git = {
        ...state.git,
        ...normalizeGitSettings({
          remoteUrl: payload.status.remoteUrl ?? state.git.remoteUrl,
          branch: payload.status.remoteBranch ?? state.git.branch,
          authMode: payload.status.authMode ?? state.git.authMode,
          tokenRef: payload.status.tokenRef ?? state.git.tokenRef,
          hasAuth: payload.status.hasAuth,
          configured: payload.status.configured
        })
      };
    }

    if (!quietSuccess) {
      setStatus(`Git ${action} succeeded`);
    }

    return payload;
  } finally {
    gitActionInFlight = false;
  }
}

async function runAutoSyncCycle() {
  if (!state.git.autoSyncEnabled) {
    return;
  }

  if (!state.git.configured) {
    state.git.autoSyncLastError = "Git remote is not configured.";
    state.git.autoSyncLastErrorAt = new Date().toISOString();
    scheduleAutoSync(state.git.autoSyncIntervalMs);
    return;
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    state.git.autoSyncLastError = "Device appears to be offline.";
    state.git.autoSyncLastErrorAt = new Date().toISOString();
    scheduleAutoSync(state.git.autoSyncIntervalMs);
    return;
  }

  try {
    const result = await runGitAction("sync", {
      quietSuccess: true,
      skipIfBusy: true
    });
    if (result?.skipped) {
      scheduleAutoSync(AUTO_SYNC_RETRY_DELAY_MS);
      return;
    }

    state.git.autoSyncLastSuccessAt = new Date().toISOString();
    state.git.autoSyncLastError = null;
    state.git.autoSyncLastErrorAt = null;
    scheduleAutoSync(state.git.autoSyncIntervalMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.git.autoSyncLastError = message;
    state.git.autoSyncLastErrorAt = new Date().toISOString();
    setStatus(`Auto sync failed: ${message}`, true);
    scheduleAutoSync(AUTO_SYNC_RETRY_DELAY_MS);
  }
}

async function refreshGitContextForCurrentUser() {
  clearAutoSyncTimer();
  loadAutoSyncPrefsForCurrentUser();
  let loaded = false;
  try {
    await loadGitSettings();
    loaded = true;
  } finally {
    if (loaded) {
      restartAutoSyncScheduler();
    }
  }
}

function openHelpMenu() {
  if (dialogOpen) {
    return;
  }

  dialogOpen = true;
  document.body.classList.add("dialog-open");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement("div");
  overlay.className = "prompt-overlay";

  const dialog = document.createElement("div");
  dialog.className = "prompt-dialog help-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Keyboard Help");

  const titleEl = document.createElement("h3");
  titleEl.className = "prompt-title";
  titleEl.textContent = "Keyboard Help";

  const hintEl = document.createElement("p");
  hintEl.className = "prompt-message";
  hintEl.textContent = "Available keys and actions";

  const list = document.createElement("div");
  list.className = "help-list";
  for (const item of HELP_SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "help-row";

    const key = document.createElement("kbd");
    key.className = "help-key";
    key.textContent = item.keys;

    const action = document.createElement("span");
    action.className = "help-action";
    action.textContent = item.action;

    row.append(key, action);
    list.append(row);
  }

  const actions = document.createElement("div");
  actions.className = "prompt-actions";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "prompt-confirm";
  closeBtn.textContent = "close";
  actions.append(closeBtn);

  let closing = false;
  const finish = () => {
    if (closing) {
      return;
    }
    closing = true;
    dialogOpen = false;
    document.body.classList.remove("dialog-open");
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
    previousFocus?.focus();
  };

  const onKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  };

  closeBtn.addEventListener("click", finish);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      finish();
    }
  });

  dialog.append(titleEl, hintEl, list, actions);
  overlay.append(dialog);
  document.body.append(overlay);
  document.addEventListener("keydown", onKeydown, true);
  closeBtn.focus();
}

async function openSettingsMenu() {
  if (dialogOpen) {
    return;
  }

  try {
    await loadGitSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to load settings: ${message}`, true);
    return;
  }

  dialogOpen = true;
  document.body.classList.add("dialog-open");

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement("div");
  overlay.className = "prompt-overlay";
  const dialog = document.createElement("div");
  dialog.className = "prompt-dialog settings-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Settings");

  const titleEl = document.createElement("h3");
  titleEl.className = "prompt-title";
  titleEl.textContent = "Settings";

  const sectionTitle = document.createElement("p");
  sectionTitle.className = "prompt-message";
  sectionTitle.textContent = "Git remote sync";

  const remoteLabel = document.createElement("label");
  remoteLabel.className = "settings-field";
  remoteLabel.textContent = "Remote URL";
  const remoteInput = document.createElement("input");
  remoteInput.className = "prompt-input";
  remoteInput.type = "text";
  remoteInput.value = state.git.remoteUrl;
  remoteInput.placeholder = "git@github.com:you/repo.git or https://github.com/you/repo.git";
  remoteLabel.append(remoteInput);

  const branchLabel = document.createElement("label");
  branchLabel.className = "settings-field";
  branchLabel.textContent = "Branch";
  const branchInput = document.createElement("input");
  branchInput.className = "prompt-input";
  branchInput.type = "text";
  branchInput.value = state.git.branch || "main";
  branchLabel.append(branchInput);

  const authLabel = document.createElement("label");
  authLabel.className = "settings-field";
  authLabel.textContent = "Auth mode";
  const authSelect = document.createElement("select");
  authSelect.className = "prompt-input";
  const sshOption = document.createElement("option");
  sshOption.value = "ssh";
  sshOption.textContent = "SSH";
  const patOption = document.createElement("option");
  patOption.value = "https_pat";
  patOption.textContent = "HTTPS + token";
  authSelect.append(sshOption, patOption);
  authSelect.value = state.git.authMode;
  authLabel.append(authSelect);

  const tokenRefLabel = document.createElement("label");
  tokenRefLabel.className = "settings-field";
  tokenRefLabel.textContent = desktopBridge ? "Token key (keychain reference)" : "Token label";
  const tokenRefInput = document.createElement("input");
  tokenRefInput.className = "prompt-input";
  tokenRefInput.type = "text";
  tokenRefInput.value = state.git.tokenRef || resolveTokenRef(getUserId());
  tokenRefLabel.append(tokenRefInput);

  const tokenLabel = document.createElement("label");
  tokenLabel.className = "settings-field";
  tokenLabel.textContent = desktopBridge ? "Token (saved to keychain)" : "Token (saved in config)";
  const tokenInput = document.createElement("input");
  tokenInput.className = "prompt-input";
  tokenInput.type = "password";
  tokenInput.value = "";
  tokenInput.placeholder = state.git.hasAuth ? "Saved. Enter to replace." : "Enter token";
  tokenLabel.append(tokenInput);

  const authHint = document.createElement("p");
  authHint.className = "prompt-message";
  authHint.textContent = desktopBridge
    ? "Electron app stores HTTPS tokens in system keychain."
    : "Browser/web mode stores token in workspace config file.";

  const autoSyncTitle = document.createElement("p");
  autoSyncTitle.className = "prompt-message";
  autoSyncTitle.textContent = "Automatic sync";

  const autoSyncEnabledLabel = document.createElement("label");
  autoSyncEnabledLabel.className = "settings-field settings-inline";
  autoSyncEnabledLabel.textContent = "Enable periodic sync";
  const autoSyncEnabledInput = document.createElement("input");
  autoSyncEnabledInput.type = "checkbox";
  autoSyncEnabledInput.checked = state.git.autoSyncEnabled;
  autoSyncEnabledLabel.append(autoSyncEnabledInput);

  const autoSyncIntervalLabel = document.createElement("label");
  autoSyncIntervalLabel.className = "settings-field";
  autoSyncIntervalLabel.textContent = "Sync interval (minutes)";
  const autoSyncIntervalInput = document.createElement("input");
  autoSyncIntervalInput.className = "prompt-input";
  autoSyncIntervalInput.type = "number";
  autoSyncIntervalInput.min = String(AUTO_SYNC_MIN_INTERVAL_MINUTES);
  autoSyncIntervalInput.max = String(AUTO_SYNC_MAX_INTERVAL_MINUTES);
  autoSyncIntervalInput.step = "1";
  autoSyncIntervalInput.value = String(clampAutoSyncIntervalMinutes(state.git.autoSyncIntervalMs / 60_000));
  autoSyncIntervalLabel.append(autoSyncIntervalInput);

  const autoSyncHint = document.createElement("p");
  autoSyncHint.className = "prompt-message";
  autoSyncHint.textContent = "Runs pull --rebase + push in the background. Conflicts may still require manual resolution.";

  const autoSyncStatus = document.createElement("p");
  autoSyncStatus.className = "prompt-message";
  autoSyncStatus.textContent = formatAutoSyncStatus();

  function syncAuthVisibility() {
    const showPat = authSelect.value === "https_pat";
    tokenRefLabel.hidden = !showPat;
    tokenLabel.hidden = !showPat;
    authHint.hidden = !showPat;
  }

  function syncAutoSyncControls() {
    autoSyncIntervalInput.disabled = !autoSyncEnabledInput.checked;
    const previewInterval = clampAutoSyncIntervalMinutes(Number(autoSyncIntervalInput.value));
    if (!autoSyncEnabledInput.checked) {
      autoSyncStatus.textContent = "Automatic sync is off.";
      return;
    }

    const parts = [`Automatic sync will run every ${previewInterval} minute(s) after save.`];
    if (state.git.autoSyncLastSuccessAt) {
      parts.push(`Last success: ${formatDate(state.git.autoSyncLastSuccessAt)}.`);
    } else {
      parts.push("Last success: never.");
    }
    if (state.git.autoSyncLastError && state.git.autoSyncLastErrorAt) {
      parts.push(`Last error (${formatDate(state.git.autoSyncLastErrorAt)}): ${state.git.autoSyncLastError}`);
    }
    autoSyncStatus.textContent = parts.join(" ");
  }

  authSelect.addEventListener("change", syncAuthVisibility);
  autoSyncEnabledInput.addEventListener("change", syncAutoSyncControls);
  autoSyncIntervalInput.addEventListener("input", syncAutoSyncControls);
  syncAuthVisibility();
  syncAutoSyncControls();

  const actionsTop = document.createElement("div");
  actionsTop.className = "prompt-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "prompt-confirm";
  saveBtn.textContent = "save";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "close";
  actionsTop.append(closeBtn, saveBtn);

  const actionsGit = document.createElement("div");
  actionsGit.className = "prompt-actions settings-actions";
  const pullBtn = document.createElement("button");
  pullBtn.type = "button";
  pullBtn.textContent = "pull";
  const pushBtn = document.createElement("button");
  pushBtn.type = "button";
  pushBtn.textContent = "push";
  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.className = "prompt-confirm";
  syncBtn.textContent = "sync";
  actionsGit.append(pullBtn, pushBtn, syncBtn);

  let closing = false;
  const finish = () => {
    if (closing) {
      return;
    }
    closing = true;
    dialogOpen = false;
    document.body.classList.remove("dialog-open");
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
    previousFocus?.focus();
  };

  const onKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  };

  async function handleSave() {
    saveBtn.disabled = true;
    try {
      const authMode = authSelect.value === "https_pat" ? "https_pat" : "ssh";
      const remoteUrl = remoteInput.value.trim();
      const branch = branchInput.value.trim() || "main";
      const tokenRef = tokenRefInput.value.trim() || resolveTokenRef(getUserId());
      const token = tokenInput.value.trim();
      const intervalMinutesRaw = Number(autoSyncIntervalInput.value);
      const intervalMinutes = clampAutoSyncIntervalMinutes(intervalMinutesRaw);

      if (
        !Number.isFinite(intervalMinutesRaw) ||
        intervalMinutesRaw < AUTO_SYNC_MIN_INTERVAL_MINUTES ||
        intervalMinutesRaw > AUTO_SYNC_MAX_INTERVAL_MINUTES
      ) {
        throw new Error(
          `Auto sync interval must be a number from ${AUTO_SYNC_MIN_INTERVAL_MINUTES} to ${AUTO_SYNC_MAX_INTERVAL_MINUTES}.`
        );
      }

      if (authMode === "https_pat" && desktopBridge) {
        if (token) {
          await maybeSetDesktopToken(tokenRef, token);
        } else if (!state.git.hasAuth) {
          throw new Error("Token is required for HTTPS auth.");
        }
      }

      const payload = await apiFetch("/api/git/settings", {
        method: "PUT",
        body: JSON.stringify({
          remoteUrl,
          branch,
          authMode,
          tokenRef: authMode === "https_pat" ? tokenRef : null,
          token: authMode === "https_pat" && !desktopBridge ? token : null
        })
      });

      if (authMode === "ssh" && desktopBridge && state.git.tokenRef) {
        await maybeDeleteDesktopToken(state.git.tokenRef);
      }

      state.git = {
        ...state.git,
        ...normalizeGitSettings(payload),
        autoSyncEnabled: autoSyncEnabledInput.checked,
        autoSyncIntervalMs: intervalMinutes * 60_000
      };
      saveAutoSyncPrefsForCurrentUser();
      restartAutoSyncScheduler();
      setStatus("Saved git settings");
      tokenInput.value = "";
      tokenInput.placeholder = state.git.hasAuth ? "Saved. Enter to replace." : "Enter token";
      syncAuthVisibility();
      syncAutoSyncControls();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Failed to save settings: ${message}`, true);
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function handleGit(action, button) {
    button.disabled = true;
    try {
      await runGitAction(action);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Git ${action} failed: ${message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  closeBtn.addEventListener("click", finish);
  saveBtn.addEventListener("click", () => {
    void handleSave();
  });
  pullBtn.addEventListener("click", () => {
    void handleGit("pull", pullBtn);
  });
  pushBtn.addEventListener("click", () => {
    void handleGit("push", pushBtn);
  });
  syncBtn.addEventListener("click", () => {
    void handleGit("sync", syncBtn);
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      finish();
    }
  });

  dialog.append(
    titleEl,
    sectionTitle,
    remoteLabel,
    branchLabel,
    authLabel,
    tokenRefLabel,
    tokenLabel,
    authHint,
    autoSyncTitle,
    autoSyncEnabledLabel,
    autoSyncIntervalLabel,
    autoSyncHint,
    autoSyncStatus,
    actionsGit,
    actionsTop
  );
  overlay.append(dialog);
  document.body.append(overlay);
  document.addEventListener("keydown", onKeydown, true);
  remoteInput.focus();
  remoteInput.select();
}

function formatDate(ts) {
  if (!ts) {
    return "-";
  }
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function listRows() {
  return buildListRows({
    query: els.searchInput.value,
    searchResults: state.searchResults,
    notes: state.notes
  });
}

function updateCachedNoteMeta(nextNoteMeta) {
  if (els.searchInput.value.trim()) {
    return;
  }

  const idx = state.notes.findIndex((entry) => entry.id === nextNoteMeta.id);
  if (idx >= 0) {
    state.notes[idx] = nextNoteMeta;
  } else {
    state.notes.unshift(nextNoteMeta);
  }

  state.notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function removeCachedNoteMeta(noteId) {
  if (els.searchInput.value.trim()) {
    return;
  }
  state.notes = state.notes.filter((entry) => entry.id !== noteId);
}

function normalizeCodeLanguage(raw) {
  const value = (raw || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (["js", "jsx", "ts", "tsx", "javascript", "typescript"].includes(value)) {
    return "javascript";
  }
  if (["py", "python"].includes(value)) {
    return "python";
  }
  if (["sh", "bash", "zsh", "shell"].includes(value)) {
    return "bash";
  }
  if (["yml"].includes(value)) {
    return "yaml";
  }
  return value;
}

function normalizeFenceLanguage(hintedLanguage, code) {
  const normalized = normalizeCodeLanguage(hintedLanguage);
  if (!normalized) {
    return "";
  }
  if (normalized === "javascript") {
    const sample = (code || "").slice(0, 500);
    if (
      /(?:^|\n)\s*(?:[A-Z_][A-Z0-9_]*=|export\s+[A-Z_][A-Z0-9_]*=|\.\/|docker\b|kubectl\b|helm\b|pnpm\b|npm\b|yarn\b|poetry\b)/m.test(
        sample
      )
    ) {
      return "bash";
    }
  }
  return normalized;
}

function createMarkdownRenderer() {
  const markdownItFactory = window.markdownit;
  const domPurify = window.DOMPurify;
  const hljs = window.hljs;

  if (typeof markdownItFactory !== "function" || !domPurify) {
    return null;
  }

  const md = markdownItFactory({
    html: true,
    linkify: true,
    typographer: false
  });

  md.linkify.set({ fuzzyEmail: false });

  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) {
      return false;
    }
    const end = src.indexOf("]]", start + 2);
    if (end < 0) {
      return false;
    }
    const target = src.slice(start + 2, end).trim();
    if (!target) {
      return false;
    }

    if (!silent) {
      const tokenOpen = state.push("link_open", "a", 1);
      tokenOpen.attrs = [
        ["href", `#note:${encodeURIComponent(target)}`],
        ["class", "internal-link"]
      ];
      const text = state.push("text", "", 0);
      text.content = `[[${target}]]`;
      state.push("link_close", "a", -1);
    }

    state.pos = end + 2;
    return true;
  });

  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, env, self) => {
      return self.renderToken(tokens, idx, options);
    });

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const hrefIdx = tokens[idx].attrIndex("href");
    if (hrefIdx >= 0) {
      const href = tokens[idx].attrs?.[hrefIdx]?.[1] ?? "";
      const hrefLower = href.toLowerCase();
      if (hrefLower.startsWith("note:")) {
        let rawTarget = href.slice(5);
        try {
          rawTarget = decodeURIComponent(rawTarget);
        } catch {
          // keep raw target when not URI encoded
        }
        tokens[idx].attrs[hrefIdx][1] = `#note:${encodeURIComponent(rawTarget)}`;
        tokens[idx].attrJoin("class", "internal-link");
      } else if (href.startsWith("#note:")) {
        tokens[idx].attrJoin("class", "internal-link");
      } else if (/^https?:\/\//i.test(href)) {
        tokens[idx].attrSet("target", "_blank");
        tokens[idx].attrSet("rel", "noopener noreferrer");
      }
    }

    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.code_inline = (tokens, idx) => {
    const content = md.utils.escapeHtml(tokens[idx].content ?? "");
    return `<code class="md-inline-code">${content}</code>`;
  };

  md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table class="md-table">';
  md.renderer.rules.table_close = () => "</table></div>";

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = md.utils.unescapeAll(token.info ?? "").trim();
    const hintedLanguage = info.split(/\s+/g)[0] ?? "";
    const code = token.content ?? "";
    const language = normalizeFenceLanguage(hintedLanguage, code);

    let classLanguage = language || "plain";
    let highlightedCode = md.utils.escapeHtml(code);

    if (hljs) {
      if (language && hljs.getLanguage(language)) {
        try {
          highlightedCode = hljs.highlight(code, { language, ignoreIllegals: true }).value;
          classLanguage = language;
        } catch {
          highlightedCode = md.utils.escapeHtml(code);
          classLanguage = language || "plain";
        }
      } else {
        try {
          const auto = hljs.highlightAuto(code);
          highlightedCode = auto.value;
          classLanguage = auto.language ? normalizeCodeLanguage(auto.language) || auto.language : "plain";
        } catch {
          highlightedCode = md.utils.escapeHtml(code);
          classLanguage = "plain";
        }
      }
    }

    const label =
      classLanguage && classLanguage !== "plain"
        ? `<div class="md-code-label">${md.utils.escapeHtml(classLanguage)}</div>`
        : "";

    return `<div class="md-code-block">${label}<pre><code class="md-code hljs language-${md.utils.escapeHtml(classLanguage)}">${highlightedCode}</code></pre></div>`;
  };

  function sanitizeHtml(html) {
    return domPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["class", "target", "rel"]
    });
  }

  return {
    render(markdown) {
      return md.render(markdown ?? "");
    },
    sanitize: sanitizeHtml
  };
}

const markdownRenderer = createMarkdownRenderer();

async function followInternalLink(sourceNoteId, targetHint) {
  const target = targetHint.trim();
  if (!target) {
    return;
  }

  try {
    if (!sourceNoteId) {
      await selectNote(target);
      return;
    }

    const result = await apiFetch("/api/follow-link", {
      method: "POST",
      body: JSON.stringify({
        source: sourceNoteId,
        target
      })
    });

    if (result.targetNoteId) {
      if (result.reason === "search") {
        els.searchInput.value = target;
        writeHashState();
        await refreshList({ preserveSelection: false, preferredNoteId: result.targetNoteId });
      } else {
        await selectNote(result.targetNoteId);
      }
      setStatus(`Followed link to ${result.targetTitle ?? result.targetNoteId}`);
      return;
    }

    setStatus(`No match for "${target}"`, true);
  } catch (error) {
    setStatus(`Failed to follow link: ${error.message}`, true);
  }
}

function bindRenderedLinks(container, sourceNoteId) {
  const anchors = container.querySelectorAll("a[href]");
  for (const anchor of anchors) {
    const href = (anchor.getAttribute("href") || "").trim();
    if (/^(?:#note:|note:)/i.test(href)) {
      anchor.classList.add("internal-link");
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        let target = href.replace(/^(?:#note:|note:)/i, "");
        try {
          target = decodeURIComponent(target);
        } catch {
          // keep literal target when malformed URI encoding
        }
        void followInternalLink(sourceNoteId, target);
      });
      continue;
    }
    if (/^https?:\/\//i.test(href)) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    }
  }
}

function renderTaskCheckboxesAsUnicode(input) {
  return String(input ?? "").replace(/^(\s*(?:[-*+]\s+)?)\[( |x|X)\](?=\s|$)/gm, (_match, prefix, marker) => {
    const symbol = marker.toLowerCase() === "x" ? "\u2611" : "\u2610";
    return `${prefix}${symbol}`;
  });
}

function renderMarkdownInto(container, markdown, sourceNoteId) {
  container.innerHTML = "";
  const body = renderTaskCheckboxesAsUnicode(markdown ?? "");
  if (!markdownRenderer) {
    container.textContent = body;
    return;
  }
  const rendered = markdownRenderer.render(body);
  const sanitized = markdownRenderer.sanitize(rendered);
  container.innerHTML = sanitized;
  bindRenderedLinks(container, sourceNoteId);
}

function createSoftLinksPanel() {
  const panel = document.createElement("aside");
  panel.className = "soft-links-panel";

  const top = state.softLinks.slice(0, 10);
  const heading = document.createElement("div");
  heading.className = "soft-links-head";
  heading.textContent = `soft links ${top.length}`;
  panel.append(heading);

  const grid = document.createElement("div");
  grid.className = "soft-links-grid";

  if (top.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-msg";
    empty.textContent = "(none)";
    grid.append(empty);
    panel.append(grid);
    return panel;
  }

  for (const [index, link] of top.entries()) {
    const row = document.createElement("a");
    row.href = "#";
    row.className = "soft-link-row";
    row.dataset.noteId = link.noteId;
    row.addEventListener("click", (event) => {
      event.preventDefault();
      setFocusPane("notes");
      void selectNote(link.noteId);
    });

    const title = document.createElement("div");
    title.className = "soft-link-title";
    title.textContent = `${index + 1}. ${link.title}`;

    const meta = document.createElement("div");
    meta.className = "soft-link-meta";
    meta.textContent = `weight ${link.weight}`;

    row.append(title, meta);
    grid.append(row);
  }

  panel.append(grid);
  return panel;
}

function renderNoteList() {
  const rows = listRows();
  els.noteList.innerHTML = "";

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-msg";
    empty.textContent = "No notes.";
    els.noteList.append(empty);
    return;
  }

  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `note-row${row.id === state.selectedNoteId ? " active" : ""}`;
    button.dataset.noteId = row.id;

    const title = document.createElement("div");
    title.className = "note-title";
    title.textContent = row.title;

    const meta = document.createElement("div");
    meta.className = "note-meta";
    const archived = row.archivedAt ? " | archived" : "";
    meta.textContent = `${row.id}${row.subtitle ? ` | ${row.subtitle}` : ""}${archived}`;

    button.append(title, meta);
    button.addEventListener("click", () => {
      setFocusPane("notes");
      void selectNote(row.id);
    });

    els.noteList.append(button);
  }
}

async function saveBody(noteId, bodyId, markdown) {
  const updated = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}/bodies/${encodeURIComponent(bodyId)}`, {
    method: "PUT",
    body: JSON.stringify({ markdown })
  });

  state.selectedNote = updated;
  state.selectedNoteId = updated.note.id;
  updateCachedNoteMeta(updated.note);
  renderNoteList();
  return updated;
}

async function renameBodyLabel(noteId, bodyId, label) {
  const updated = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}/bodies/${encodeURIComponent(bodyId)}/label`, {
    method: "PUT",
    body: JSON.stringify({ label })
  });

  state.selectedNote = updated;
  state.selectedNoteId = updated.note.id;
  updateCachedNoteMeta(updated.note);
  renderNoteList();
  return updated;
}

async function deleteBody(noteId, bodyId) {
  const updated = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}/bodies/${encodeURIComponent(bodyId)}`, {
    method: "DELETE"
  });

  state.selectedNote = updated;
  state.selectedNoteId = updated.note.id;
  const bodyCount = updated.bodies?.length ?? 0;
  state.activeBodyIndex = bodyCount === 0 ? 0 : Math.min(state.activeBodyIndex, bodyCount - 1);
  updateCachedNoteMeta(updated.note);
  renderNoteList();
  return updated;
}

async function moveBodyToNote(noteId, bodyId, targetNoteRef) {
  const moved = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}/bodies/${encodeURIComponent(bodyId)}/move`, {
    method: "POST",
    body: JSON.stringify({ targetNoteRef })
  });

  if (moved.sourceDeleted) {
    removeCachedNoteMeta(moved.sourceNoteId);
  } else if (moved.source?.note) {
    updateCachedNoteMeta(moved.source.note);
  }
  updateCachedNoteMeta(moved.target.note);

  if (state.selectedNoteId === moved.sourceNoteId) {
    if (moved.sourceDeleted) {
      state.selectedNote = moved.target;
      state.selectedNoteId = moved.target.note.id;
      const movedIndex = moved.target.bodies.findIndex((entry) => entry.id === moved.movedBodyId);
      state.activeBodyIndex = movedIndex >= 0 ? movedIndex : 0;
    } else if (moved.source) {
      state.selectedNote = moved.source;
      const sourceBodyCount = moved.source.bodies?.length ?? 0;
      state.activeBodyIndex = sourceBodyCount === 0 ? 0 : Math.min(state.activeBodyIndex, sourceBodyCount - 1);
    }
  } else if (state.selectedNoteId === moved.target.note.id) {
    state.selectedNote = moved.target;
    const movedIndex = moved.target.bodies.findIndex((entry) => entry.id === moved.movedBodyId);
    if (movedIndex >= 0) {
      state.activeBodyIndex = movedIndex;
    }
  }

  renderNoteList();
  return moved;
}

async function renameNote(noteId, title) {
  const updated = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}/title`, {
    method: "PUT",
    body: JSON.stringify({ title })
  });

  state.selectedNote = updated;
  state.selectedNoteId = updated.note.id;
  updateCachedNoteMeta(updated.note);
  renderNoteList();
  return updated;
}

function renderNoteDetail() {
  const note = state.selectedNote;
  if (!note) {
    els.noteDetail.className = "note-detail empty";
    els.noteDetail.textContent = "Select a note.";
    return;
  }

  els.noteDetail.className = "note-detail";
  els.noteDetail.innerHTML = "";

  const header = document.createElement("header");
  header.className = "detail-head";
  const selectedBodyIndex =
    note.bodies.length === 0 ? 0 : Math.max(0, Math.min(note.bodies.length - 1, state.activeBodyIndex));
  state.activeBodyIndex = selectedBodyIndex;

  const headMain = document.createElement("div");
  headMain.className = "detail-head-main";

  const h2 = document.createElement("h2");
  h2.textContent = note.note.title;

  const subline = document.createElement("div");
  subline.className = "detail-subline";
  subline.textContent = `${note.note.id} | updated ${formatDate(note.note.updatedAt)}${
    note.note.archivedAt ? " | archived" : ""
  }`;

  headMain.append(h2, subline);

  const headActions = document.createElement("div");
  headActions.className = "detail-head-actions";

  const addBodyBtn = document.createElement("button");
  addBodyBtn.type = "button";
  addBodyBtn.className = "detail-head-btn";
  addBodyBtn.textContent = "add body";
  addBodyBtn.addEventListener("click", () => {
    void runCommand(addBodyFromPrompt);
  });

  const archiveBtn = document.createElement("button");
  archiveBtn.type = "button";
  archiveBtn.className = "detail-head-btn";
  archiveBtn.textContent = note.note.archivedAt ? "restore" : "archive";
  archiveBtn.addEventListener("click", () => {
    void runCommand(note.note.archivedAt ? restoreSelectedNote : archiveSelectedNote);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "detail-head-btn";
  deleteBtn.textContent = "delete";
  deleteBtn.addEventListener("click", () => {
    void runCommand(deleteSelectedNote);
  });

  headActions.append(addBodyBtn, archiveBtn, deleteBtn);
  header.append(headMain, headActions);
  els.noteDetail.append(header);

  const detailContent = document.createElement("div");
  detailContent.className = "detail-content";

  const detailMain = document.createElement("div");
  detailMain.className = "detail-main";

  const softLinksPanel = createSoftLinksPanel();

  if (note.bodies.length === 0) {
    state.activeBodyIndex = 0;
    const empty = document.createElement("div");
    empty.className = "empty-msg";
    empty.textContent = "No bodies on this note.";
    detailMain.append(empty);
    detailContent.append(detailMain, softLinksPanel);
    els.noteDetail.append(detailContent);
    return;
  }

  for (const [bodyIndex, body] of note.bodies.entries()) {
    const card = document.createElement("section");
    const isActiveBody = bodyIndex === state.activeBodyIndex;
    card.className = `body-card${isActiveBody ? " active" : ""}`;
    card.dataset.bodyIndex = String(bodyIndex);

    const bodyKey = `${note.note.id}:${body.id}`;
    const isEditing = state.editingBodyIds.has(bodyKey);
    const isSaving = state.savingBodyIds.has(bodyKey);

    const label = document.createElement("div");
    label.className = "body-label";
    const labelText = document.createElement("span");
    labelText.className = "body-label-text";
    labelText.textContent = `${body.label} | ${formatDate(body.updatedAt)}`;
    label.append(labelText);

    if (!isEditing) {
      const labelActions = document.createElement("div");
      labelActions.className = "body-label-actions";

      const prevBodyBtn = document.createElement("button");
      prevBodyBtn.type = "button";
      prevBodyBtn.className = "body-label-btn";
      prevBodyBtn.textContent = "<<";
      prevBodyBtn.title = "Previous body";
      prevBodyBtn.disabled = isSaving || note.bodies.length <= 1 || bodyIndex <= 0;
      prevBodyBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.activeBodyIndex = bodyIndex;
        selectBodyBy(-1);
      });

      const nextBodyBtn = document.createElement("button");
      nextBodyBtn.type = "button";
      nextBodyBtn.className = "body-label-btn";
      nextBodyBtn.textContent = ">>";
      nextBodyBtn.title = "Next body";
      nextBodyBtn.disabled = isSaving || note.bodies.length <= 1 || bodyIndex >= note.bodies.length - 1;
      nextBodyBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.activeBodyIndex = bodyIndex;
        selectBodyBy(1);
      });

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "body-label-btn";
      editBtn.textContent = "edit note";
      editBtn.disabled = isSaving;
      editBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.editingBodyIds.add(bodyKey);
        state.bodyDrafts.set(bodyKey, formatEditableNoteContent(note.note.title, body.markdown));
        renderNoteDetail();
      });

      const renameLabelBtn = document.createElement("button");
      renameLabelBtn.type = "button";
      renameLabelBtn.className = "body-label-btn";
      renameLabelBtn.textContent = "rename label";
      renameLabelBtn.disabled = isSaving;
      renameLabelBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        void (async () => {
          const next = await promptForInput("New body label:", {
            defaultValue: body.label,
            confirmLabel: "rename"
          });
          if (next === null) {
            return;
          }
          const trimmed = next.trim();
          if (!trimmed) {
            setStatus("Body label is required", true);
            return;
          }
          if (trimmed === body.label) {
            setStatus("Body label unchanged");
            return;
          }

          state.savingBodyIds.add(bodyKey);
          renderNoteDetail();
          try {
            const updated = await renameBodyLabel(note.note.id, body.id, trimmed);
            setStatus(`Renamed body label on ${updated.note.title}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setStatus(`Failed to rename body label: ${message}`, true);
          } finally {
            state.savingBodyIds.delete(bodyKey);
            renderNoteDetail();
          }
        })();
      });

      const moveBodyBtn = document.createElement("button");
      moveBodyBtn.type = "button";
      moveBodyBtn.className = "body-label-btn";
      moveBodyBtn.textContent = "move to note";
      moveBodyBtn.disabled = isSaving;
      moveBodyBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        void (async () => {
          const target = await promptForMoveTarget(note.note.id);
          if (target === null) {
            return;
          }
          const targetNoteRef = target.trim();
          if (!targetNoteRef) {
            setStatus("Target note is required", true);
            return;
          }

          state.savingBodyIds.add(bodyKey);
          renderNoteDetail();
          try {
            const moved = await moveBodyToNote(note.note.id, body.id, targetNoteRef);
            state.editingBodyIds.delete(bodyKey);
            state.bodyDrafts.delete(bodyKey);
            setStatus(`Moved body "${body.label}" to ${moved.target.note.title}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setStatus(`Failed to move body: ${message}`, true);
          } finally {
            state.savingBodyIds.delete(bodyKey);
            renderNoteDetail();
          }
        })();
      });

      const deleteBodyBtn = document.createElement("button");
      deleteBodyBtn.type = "button";
      deleteBodyBtn.className = "body-label-btn";
      deleteBodyBtn.textContent = "delete body";
      deleteBodyBtn.disabled = isSaving;
      deleteBodyBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        void (async () => {
          const confirmed = await confirmAction(`Delete body "${body.label}" permanently?`, {
            confirmLabel: "delete"
          });
          if (!confirmed) {
            return;
          }

          state.savingBodyIds.add(bodyKey);
          renderNoteDetail();
          try {
            const updated = await deleteBody(note.note.id, body.id);
            setStatus(`Deleted body from ${updated.note.title}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setStatus(`Failed to delete body: ${message}`, true);
          } finally {
            state.savingBodyIds.delete(bodyKey);
            state.editingBodyIds.delete(bodyKey);
            state.bodyDrafts.delete(bodyKey);
            renderNoteDetail();
          }
        })();
      });

      labelActions.append(prevBodyBtn, nextBodyBtn, editBtn, renameLabelBtn, moveBodyBtn, deleteBodyBtn);
      label.append(labelActions);
    }

    label.addEventListener("click", () => {
      state.activeBodyIndex = bodyIndex;
      state.focusPane = "body";
      applyUiState();
      renderNoteDetail();
    });

    const wrap = document.createElement("div");
    wrap.className = "body-editor-wrap";

    if (!isEditing) {
      const text = document.createElement("div");
      text.className = "body-markdown";
      renderMarkdownInto(text, body.markdown, note.note.id);
      wrap.append(text);
      card.append(label, wrap);
      detailMain.append(card);
      continue;
    }

    const baseEditorValue = formatEditableNoteContent(note.note.title, body.markdown);
    if (!state.bodyDrafts.has(bodyKey)) {
      state.bodyDrafts.set(bodyKey, baseEditorValue);
    }
    const editor = document.createElement("textarea");
    editor.className = "body-editor";
    editor.rows = 36;
    editor.value = state.bodyDrafts.get(bodyKey) ?? baseEditorValue;
    editor.setAttribute("spellcheck", "false");
    editor.disabled = isSaving;

    const actions = document.createElement("div");
    actions.className = "body-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.disabled = isSaving || editor.value === baseEditorValue;
    saveBtn.textContent = isSaving ? "saving..." : "save";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "cancel";
    cancelBtn.disabled = isSaving;

    const saveState = document.createElement("span");
    saveState.className = "body-state";
    saveState.textContent = isSaving
      ? "Saving changes"
      : editor.value === baseEditorValue
        ? "No pending changes"
        : "Unsaved changes";

    async function persistBody() {
      const draft = editor.value;
      if (draft === baseEditorValue) {
        return;
      }

      let parsed = null;
      try {
        parsed = parseEditedNoteContent(draft);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.bodyDrafts.set(bodyKey, prependEditErrorComment(draft, message));
        setStatus(`Invalid edit format: ${message}`, true);
        renderNoteDetail();
        return;
      }

      const titleChanged = parsed.title !== note.note.title;
      const markdownChanged = parsed.markdown !== body.markdown;
      if (!titleChanged && !markdownChanged) {
        return;
      }

      let saved = false;
      state.savingBodyIds.add(bodyKey);
      renderNoteDetail();
      try {
        let updated = note;
        if (titleChanged) {
          updated = await renameNote(note.note.id, parsed.title);
        }
        if (markdownChanged) {
          updated = await saveBody(note.note.id, body.id, parsed.markdown);
        }
        state.editingBodyIds.delete(bodyKey);
        state.bodyDrafts.delete(bodyKey);
        if (titleChanged && markdownChanged) {
          setStatus(`Saved title and body for ${updated.note.title}`);
        } else if (titleChanged) {
          setStatus(`Saved title for ${updated.note.title}`);
        } else {
          setStatus(`Saved body for ${updated.note.title}`);
        }
        saved = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Failed to save note: ${message}`, true);
      } finally {
        state.savingBodyIds.delete(bodyKey);
        if (!saved) {
          state.bodyDrafts.set(bodyKey, draft);
        }
        renderNoteDetail();
      }
    }

    saveBtn.addEventListener("click", () => {
      void persistBody();
    });

    cancelBtn.addEventListener("click", () => {
      state.editingBodyIds.delete(bodyKey);
      state.bodyDrafts.delete(bodyKey);
      setStatus("Edit cancelled");
      renderNoteDetail();
    });

    editor.addEventListener("input", () => {
      state.bodyDrafts.set(bodyKey, editor.value);
      saveBtn.disabled = editor.value === baseEditorValue;
      saveState.textContent = editor.value === baseEditorValue ? "No pending changes" : "Unsaved changes";
    });

    editor.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void persistBody();
      }
    });

    actions.append(saveBtn, cancelBtn, saveState);
    wrap.append(editor, actions);

    card.append(label, wrap);
    detailMain.append(card);
  }

  detailContent.append(detailMain, softLinksPanel);
  els.noteDetail.append(detailContent);
}

async function selectNote(noteId) {
  if (!noteId) {
    return;
  }

  state.selectedNoteId = noteId;
  writeHashState();
  if (isMobileViewport()) {
    state.sidebarOpen = false;
    applyUiState();
  }

  renderNoteList();
  setStatus("Loading note...");

  try {
    const [noteData, softLinksData] = await Promise.all([
      apiFetch(`/api/notes/${encodeURIComponent(noteId)}`),
      apiFetch(`/api/notes/${encodeURIComponent(noteId)}/soft-links?limit=10`).catch(() => [])
    ]);
    state.selectedNote = noteData;
    state.softLinks = Array.isArray(softLinksData)
      ? softLinksData
          .map((entry) => ({
            noteId: String(entry?.noteId ?? ""),
            title: String(entry?.title ?? ""),
            weight: Number(entry?.weight ?? 0)
          }))
          .filter((entry) => entry.noteId)
      : [];
    state.activeBodyIndex = 0;
    state.savingBodyIds.clear();
    state.editingBodyIds.clear();
    state.bodyDrafts.clear();
    renderNoteDetail();
    const bodyCount = state.selectedNote?.bodies?.length ?? 0;
    setStatus(`Loaded ${state.selectedNote.note.title} (${bodyCount} bodies)`);
  } catch (error) {
    state.selectedNote = null;
    state.softLinks = [];
    renderNoteDetail();
    setStatus(`Failed to load note: ${error.message}`, true);
  }
}

async function fetchList() {
  const query = els.searchInput.value.trim();
  const includeArchived = els.includeArchived.checked;

  if (!query) {
    state.searchResults = [];
    state.notes = await apiFetch(`/api/notes?includeArchived=${includeArchived}`);
    return;
  }

  state.notes = [];
  state.searchResults = await apiFetch(
    `/api/search?q=${encodeURIComponent(query)}&limit=50&includeArchived=${includeArchived}`
  );
}

async function refreshList({ preserveSelection = true, preferredNoteId = null } = {}) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  state.includeArchived = els.includeArchived.checked;
  writeHashState();
  setStatus("Loading notes...");

  try {
    await fetchList();

    const rows = listRows();
    const searching = els.searchInput.value.trim().length > 0;
    const preferredStillVisible = preferredNoteId ? rows.some((row) => row.id === preferredNoteId) : false;
    const selectedStillVisible = preserveSelection && rows.some((row) => row.id === state.selectedNoteId);

    if (preferredStillVisible) {
      state.selectedNoteId = preferredNoteId;
    } else if (!selectedStillVisible) {
      state.selectedNoteId = rows[0]?.id ?? null;
    }

    renderNoteList();
    if (searching) {
      els.noteList.scrollTop = 0;
    }
    writeHashState();

    if (state.selectedNoteId) {
      await selectNote(state.selectedNoteId);
    } else {
      state.selectedNote = null;
      state.softLinks = [];
      state.selectedNoteId = null;
      renderNoteDetail();
      writeHashState();
      setStatus("No notes found.");
    }
  } catch (error) {
    setStatus(`Failed to load notes: ${error.message}`, true);
  } finally {
    state.loading = false;
  }
}

let searchTimer = null;
function scheduleSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    void refreshList({ preserveSelection: false });
  }, 180);
}

async function runCommand(task) {
  try {
    await task();
  } catch (error) {
    setStatus(`Error: ${error.message}`, true);
  }
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  writePersisted(KEY_THEME, state.theme);
  applyUiState();
}

function toggleWideMode() {
  state.wide = !state.wide;
  state.sidebarOpen = false;
  writePersisted(KEY_WIDE, String(state.wide));
  applyUiState();
  renderNoteDetail();
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  applyUiState();
}

function closeSidebar() {
  if (!state.sidebarOpen) {
    return;
  }
  state.sidebarOpen = false;
  applyUiState();
}

function isEditableElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function setFocusPane(pane) {
  if (state.focusPane === pane) {
    return;
  }
  state.focusPane = pane;
  applyUiState();
}

function notePageSize() {
  return Math.max(1, Math.floor(els.noteList.clientHeight / 56) - 1);
}

function moveSelectionBy(delta) {
  const rows = listRows();
  if (rows.length === 0) {
    return;
  }

  const currentIndex = rows.findIndex((row) => row.id === state.selectedNoteId);
  const base = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = Math.max(0, Math.min(rows.length - 1, base + delta));
  const next = rows[nextIndex];
  if (!next || next.id === state.selectedNoteId) {
    return;
  }

  void selectNote(next.id).then(() => {
    const active = els.noteList.querySelector(".note-row.active");
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ block: "nearest" });
    }
  });
}

function jumpSelection(toEnd) {
  const rows = listRows();
  if (rows.length === 0) {
    return;
  }
  const targetIndex = toEnd ? rows.length - 1 : 0;
  const target = rows[targetIndex];
  if (!target) {
    return;
  }
  void selectNote(target.id).then(() => {
    const active = els.noteList.querySelector(".note-row.active");
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ block: "nearest" });
    }
  });
}

function scrollBodyBy(deltaPx) {
  window.scrollBy({ top: deltaPx, behavior: "auto" });
}

function scrollBodyCardToTop(bodyIndex) {
  const card = els.noteDetail.querySelector(`.body-card[data-body-index="${bodyIndex}"]`);
  if (!(card instanceof HTMLElement)) {
    return;
  }

  const targetTop = Math.max(0, window.scrollY + card.getBoundingClientRect().top - 8);
  window.scrollTo({ top: targetTop, behavior: "auto" });
}

function selectBodyBy(delta) {
  const note = state.selectedNote;
  if (!note || note.bodies.length === 0) {
    return;
  }
  const next = Math.max(0, Math.min(note.bodies.length - 1, state.activeBodyIndex + delta));
  if (next === state.activeBodyIndex) {
    return;
  }
  state.activeBodyIndex = next;
  state.focusPane = "body";
  applyUiState();
  renderNoteDetail();
  scrollBodyCardToTop(next);
  window.requestAnimationFrame(() => {
    scrollBodyCardToTop(next);
  });
}

function isPrevBodyShortcut(event) {
  return event.key === "[" || event.key === "<" || (event.shiftKey && event.code === "Comma");
}

function isNextBodyShortcut(event) {
  return event.key === "]" || event.key === ">" || (event.shiftKey && event.code === "Period");
}

function enterEditOnActiveBody() {
  const note = state.selectedNote;
  if (!note || note.bodies.length === 0) {
    setStatus("No note body selected");
    return;
  }
  const body = note.bodies[state.activeBodyIndex];
  if (!body) {
    return;
  }
  const bodyKey = `${note.note.id}:${body.id}`;
  state.editingBodyIds.add(bodyKey);
  state.bodyDrafts.set(bodyKey, formatEditableNoteContent(note.note.title, body.markdown));
  state.focusPane = "body";
  applyUiState();
  renderNoteDetail();
}

function cancelEditMode() {
  if (state.editingBodyIds.size === 0) {
    return false;
  }
  state.editingBodyIds.clear();
  state.bodyDrafts.clear();
  setStatus("Edit cancelled");
  renderNoteDetail();
  return true;
}

async function createNoteFromPrompt() {
  const title = await promptForInput("New note title:", { confirmLabel: "create" });
  if (!title || !title.trim()) {
    return;
  }
  const created = await apiFetch("/api/notes", {
    method: "POST",
    body: JSON.stringify({ title: title.trim() })
  });
  state.selectedNoteId = created.note.id;
  await refreshList({ preserveSelection: false });
  await selectNote(created.note.id);
  setStatus(`Created ${created.note.title}`);
}

async function addBodyFromPrompt() {
  const selectedId = state.selectedNote?.note.id ?? state.selectedNoteId;
  if (!selectedId) {
    setStatus("No note selected");
    return;
  }
  const markdown = await promptForInput("Body markdown:", {
    multiline: true,
    confirmLabel: "add"
  });
  if (!markdown || !markdown.trim()) {
    return;
  }
  const updated = await apiFetch(`/api/notes/${encodeURIComponent(selectedId)}/bodies`, {
    method: "POST",
    body: JSON.stringify({ markdown })
  });
  state.selectedNote = updated;
  state.selectedNoteId = updated.note.id;
  state.activeBodyIndex = Math.max(0, updated.bodies.length - 1);
  updateCachedNoteMeta(updated.note);
  renderNoteList();
  renderNoteDetail();
  setStatus("Added body");
}

async function followFromPrompt() {
  const sourceId = state.selectedNote?.note.id ?? state.selectedNoteId;
  if (!sourceId) {
    setStatus("No note selected");
    return;
  }
  const target = await promptForInput("Follow target:", { confirmLabel: "follow" });
  if (!target || !target.trim()) {
    return;
  }
  await followInternalLink(sourceId, target);
}

async function deleteActiveBody() {
  const note = state.selectedNote;
  if (!note || note.bodies.length === 0) {
    setStatus("No note body selected");
    return;
  }

  const body = note.bodies[state.activeBodyIndex];
  if (!body) {
    setStatus("No note body selected");
    return;
  }

  const confirmed = await confirmAction(`Delete body "${body.label}" permanently?`, {
    confirmLabel: "delete"
  });
  if (!confirmed) {
    return;
  }

  const bodyKey = `${note.note.id}:${body.id}`;
  state.savingBodyIds.add(bodyKey);
  renderNoteDetail();
  try {
    const updated = await deleteBody(note.note.id, body.id);
    setStatus(`Deleted body from ${updated.note.title}`);
  } finally {
    state.savingBodyIds.delete(bodyKey);
    state.editingBodyIds.delete(bodyKey);
    state.bodyDrafts.delete(bodyKey);
    renderNoteDetail();
  }
}

async function archiveSelectedNote() {
  const selectedId = state.selectedNote?.note.id ?? state.selectedNoteId;
  if (!selectedId) {
    setStatus("No note selected");
    return;
  }
  const updated = await apiFetch(`/api/notes/${encodeURIComponent(selectedId)}/archive`, { method: "POST" });
  await refreshList({ preserveSelection: false });
  await selectNote(updated.note.id);
  setStatus(`Archived ${updated.note.title}`);
}

async function restoreSelectedNote() {
  const selectedId = state.selectedNote?.note.id ?? state.selectedNoteId;
  if (!selectedId) {
    setStatus("No note selected");
    return;
  }
  const updated = await apiFetch(`/api/notes/${encodeURIComponent(selectedId)}/restore`, { method: "POST" });
  await refreshList({ preserveSelection: false });
  await selectNote(updated.note.id);
  setStatus(`Restored ${updated.note.title}`);
}

async function deleteSelectedNote() {
  const selectedId = state.selectedNote?.note.id ?? state.selectedNoteId;
  const selectedTitle = state.selectedNote?.note.title ?? selectedId;
  if (!selectedId) {
    setStatus("No note selected");
    return;
  }
  const confirmed = await confirmAction(`Delete "${selectedTitle}" permanently?`, {
    confirmLabel: "delete"
  });
  if (!confirmed) {
    return;
  }
  await apiFetch(`/api/notes/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
  await refreshList({ preserveSelection: false });
  setStatus(`Deleted ${selectedTitle}`);
}

async function toggleArchivedFilter() {
  state.includeArchived = !state.includeArchived;
  els.includeArchived.checked = state.includeArchived;
  writeHashState();
  await refreshList({ preserveSelection: false });
  setStatus(state.includeArchived ? "Showing archived notes" : "Hiding archived notes");
}

function onGlobalKeydown(event) {
  if (event.defaultPrevented || event.metaKey || event.altKey) {
    return;
  }
  if (dialogOpen) {
    return;
  }

  if (event.key === "Escape") {
    if (isEditableElement(document.activeElement)) {
      document.activeElement.blur();
      return;
    }
    if (cancelEditMode()) {
      return;
    }
    if (state.sidebarOpen) {
      closeSidebar();
    }
    return;
  }

  if (isEditableElement(document.activeElement)) {
    return;
  }
  if (state.loading) {
    return;
  }

  if (event.ctrlKey && (event.key === "d" || event.key === "u")) {
    event.preventDefault();
    if (state.focusPane === "notes") {
      const delta = event.key === "d" ? Math.max(1, Math.floor(notePageSize() / 2)) : -Math.max(1, Math.floor(notePageSize() / 2));
      moveSelectionBy(delta);
    } else {
      const delta = event.key === "d" ? Math.floor(window.innerHeight * 0.45) : -Math.floor(window.innerHeight * 0.45);
      scrollBodyBy(delta);
    }
    return;
  }

  if (event.ctrlKey) {
    return;
  }
  if (state.editingBodyIds.size > 0) {
    return;
  }

  if (event.key === "?") {
    event.preventDefault();
    openHelpMenu();
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    setFocusPane(state.focusPane === "notes" ? "body" : "notes");
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setFocusPane("notes");
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    setFocusPane("body");
    return;
  }

  if (event.key === "/") {
    event.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
    return;
  }

  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      moveSelectionBy(1);
    } else {
      scrollBodyBy(48);
    }
    return;
  }

  if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      moveSelectionBy(-1);
    } else {
      scrollBodyBy(-48);
    }
    return;
  }

  if (event.key === "PageDown") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      moveSelectionBy(notePageSize());
    } else {
      scrollBodyBy(Math.floor(window.innerHeight * 0.9));
    }
    return;
  }

  if (event.key === "PageUp") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      moveSelectionBy(-notePageSize());
    } else {
      scrollBodyBy(-Math.floor(window.innerHeight * 0.9));
    }
    return;
  }

  if (event.key === "J") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      moveSelectionBy(Math.max(1, Math.floor(notePageSize() / 2)));
    } else {
      scrollBodyBy(Math.floor(window.innerHeight * 0.45));
    }
    return;
  }

  if (event.key === "K") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      moveSelectionBy(-Math.max(1, Math.floor(notePageSize() / 2)));
    } else {
      scrollBodyBy(-Math.floor(window.innerHeight * 0.45));
    }
    return;
  }

  if (event.key === "g") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      jumpSelection(false);
    } else {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    return;
  }

  if (event.key === "G") {
    event.preventDefault();
    if (state.focusPane === "notes") {
      jumpSelection(true);
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
    }
    return;
  }

  if (isPrevBodyShortcut(event)) {
    event.preventDefault();
    selectBodyBy(-1);
    return;
  }

  if (isNextBodyShortcut(event)) {
    event.preventDefault();
    selectBodyBy(1);
    return;
  }

  if (event.key === "e") {
    event.preventDefault();
    enterEditOnActiveBody();
    return;
  }

  if (event.key === "s") {
    event.preventDefault();
    void refreshList({ preserveSelection: true });
    return;
  }

  if (event.key === "x") {
    event.preventDefault();
    void runCommand(toggleArchivedFilter);
    return;
  }

  if (event.key === "a") {
    event.preventDefault();
    void runCommand(archiveSelectedNote);
    return;
  }

  if (event.key === "r") {
    event.preventDefault();
    void runCommand(restoreSelectedNote);
    return;
  }

  if (event.key === "D") {
    event.preventDefault();
    void runCommand(deleteSelectedNote);
    return;
  }

  if (event.key === "d") {
    event.preventDefault();
    if (state.focusPane === "body") {
      void runCommand(deleteActiveBody);
    }
    return;
  }

  if (event.key === "n") {
    event.preventDefault();
    void runCommand(createNoteFromPrompt);
    return;
  }

  if (event.key === "b") {
    event.preventDefault();
    void runCommand(addBodyFromPrompt);
    return;
  }

  if (event.key === "f") {
    event.preventDefault();
    void runCommand(followFromPrompt);
    return;
  }

  if (event.key === "t") {
    event.preventDefault();
    toggleTheme();
    return;
  }

  if (event.key === "w") {
    event.preventDefault();
    toggleWideMode();
    return;
  }

  if (event.key === ",") {
    event.preventDefault();
    void openSettingsMenu();
  }
}

els.refreshBtn.addEventListener("click", () => {
  void refreshList({ preserveSelection: true });
});

els.includeArchived.addEventListener("change", () => {
  state.includeArchived = els.includeArchived.checked;
  writeHashState();
  void refreshList({ preserveSelection: false });
});

els.searchInput.addEventListener("input", () => {
  writeHashState();
  scheduleSearch();
});

els.userId.addEventListener("change", () => {
  void refreshList({ preserveSelection: false });
  void refreshGitContextForCurrentUser().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to load git settings: ${message}`, true);
  });
});

els.toggleThemeBtn.addEventListener("click", toggleTheme);
els.toggleWideBtn.addEventListener("click", toggleWideMode);
els.toggleNotesBtn.addEventListener("click", toggleSidebar);
els.openHelpBtn.addEventListener("click", () => {
  openHelpMenu();
});
els.openSettingsBtn.addEventListener("click", () => {
  void openSettingsMenu();
});
els.closeSidebarBtn.addEventListener("click", closeSidebar);
els.sidebarBackdrop.addEventListener("click", closeSidebar);

window.addEventListener("resize", () => {
  if (!isMobileViewport()) {
    state.sidebarOpen = false;
  }
  applyUiState();
});
window.addEventListener("keydown", onGlobalKeydown);

initUiPrefs();
const initialPreferredNoteId = applyInitialHashState();
writeHashState();
void refreshList({ preserveSelection: false, preferredNoteId: initialPreferredNoteId });
void refreshGitContextForCurrentUser().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`Failed to load git settings: ${message}`, true);
});
