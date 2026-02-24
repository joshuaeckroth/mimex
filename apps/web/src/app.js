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
  closeSidebarBtn: document.querySelector("#closeSidebarBtn"),
  sidebarBackdrop: document.querySelector("#sidebarBackdrop")
};

const KEY_THEME = "mimex:web:theme";
const KEY_WIDE = "mimex:web:wide";
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
  sidebarOpen: false
};

const EDIT_TITLE_PREFIX = "%% MIMEX_TITLE:";
const EDIT_ERROR_MARKER = "MIMEX_EDIT_ERROR";
const EDIT_ERROR_LINE_RE = /^<!--\s*MIMEX_EDIT_ERROR:\s*.*-->$/;

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusRow.classList.toggle("error", isError);
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
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (!raw) {
    return { noteId: null, query: null, includeArchived: null };
  }

  if (!raw.includes("=") && !raw.includes("&")) {
    try {
      return { noteId: decodeURIComponent(raw), query: null, includeArchived: null };
    } catch {
      return { noteId: raw, query: null, includeArchived: null };
    }
  }

  const params = new URLSearchParams(raw);
  const noteId = (params.get("note") || "").trim() || null;
  const query = params.has("q") ? (params.get("q") ?? "") : null;

  let includeArchived = null;
  if (params.has("archived")) {
    const archivedRaw = (params.get("archived") || "").trim().toLowerCase();
    includeArchived = archivedRaw === "1" || archivedRaw === "true" || archivedRaw === "yes";
  }

  return { noteId, query, includeArchived };
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
  const params = new URLSearchParams();
  const query = els.searchInput.value.trim();
  if (query) {
    params.set("q", query);
  }
  if (els.includeArchived.checked) {
    params.set("archived", "1");
  }
  if (state.selectedNoteId) {
    params.set("note", state.selectedNoteId);
  }

  const hash = params.toString();
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

function sanitizeEditErrorMessage(message) {
  return String(message || "")
    .replace(/\r?\n/g, " ")
    .replace(/-->/g, "-- >")
    .trim();
}

function formatEditableNoteContent(title, markdown, errorMessage) {
  const lines = [];
  if (errorMessage) {
    lines.push(`<!-- ${EDIT_ERROR_MARKER}: ${sanitizeEditErrorMessage(errorMessage)} -->`);
  }
  lines.push(`${EDIT_TITLE_PREFIX} ${String(title || "").trim()}`);
  lines.push("");
  if (markdown) {
    lines.push(String(markdown));
  }
  return lines.join("\n");
}

function stripLeadingEditErrorComments(content) {
  return String(content || "").replace(/^(?:<!--\s*MIMEX_EDIT_ERROR:\s*.*-->\n?)*/, "");
}

function prependEditErrorComment(content, errorMessage) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const stripped = stripLeadingEditErrorComments(normalized);
  const comment = `<!-- ${EDIT_ERROR_MARKER}: ${sanitizeEditErrorMessage(errorMessage)} -->`;
  if (!stripped) {
    return `${comment}\n`;
  }
  return `${comment}\n${stripped}`;
}

function parseEditedNoteContent(content) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let index = 0;

  while (index < lines.length) {
    const trimmed = (lines[index] || "").trim();
    if (!trimmed || EDIT_ERROR_LINE_RE.test(trimmed)) {
      index += 1;
      continue;
    }
    if (!trimmed.startsWith(EDIT_TITLE_PREFIX)) {
      throw new Error(`missing title marker (${EDIT_TITLE_PREFIX} <title>) at top of file`);
    }
    const title = trimmed.slice(EDIT_TITLE_PREFIX.length).trim();
    if (!title) {
      throw new Error("title marker is empty");
    }

    index += 1;
    if (index < lines.length && !(lines[index] || "").trim()) {
      index += 1;
    }

    return {
      title,
      markdown: lines.slice(index).join("\n")
    };
  }

  throw new Error(`missing title marker (${EDIT_TITLE_PREFIX} <title>) at top of file`);
}

function listRows() {
  if (state.searchResults.length > 0 || els.searchInput.value.trim()) {
    return state.searchResults.map((result) => ({
      id: result.noteId,
      title: result.title,
      subtitle: `score ${result.score}`,
      archivedAt: null
    }));
  }

  return state.notes.map((note) => ({
    id: note.id,
    title: note.title,
    subtitle: `${note.bodies.length} bodies`,
    archivedAt: note.archivedAt
  }));
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

function renderMarkdownInto(container, markdown, sourceNoteId) {
  container.innerHTML = "";
  const body = markdown ?? "";
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

  state.activeBodyIndex = Math.max(0, Math.min(note.bodies.length - 1, state.activeBodyIndex));

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

      labelActions.append(editBtn);
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
  const active = els.noteDetail.querySelector(".body-card.active");
  if (active instanceof HTMLElement) {
    active.scrollIntoView({ block: "nearest" });
  }
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
  const title = window.prompt("New note title:");
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
  const markdown = window.prompt("Body markdown:");
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
  const target = window.prompt("Follow target:");
  if (!target || !target.trim()) {
    return;
  }
  await followInternalLink(sourceId, target);
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
  if (!window.confirm(`Delete "${selectedTitle}" permanently?`)) {
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

  if (event.key === "[") {
    event.preventDefault();
    selectBodyBy(-1);
    return;
  }

  if (event.key === "]") {
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
});

els.toggleThemeBtn.addEventListener("click", toggleTheme);
els.toggleWideBtn.addEventListener("click", toggleWideMode);
els.toggleNotesBtn.addEventListener("click", toggleSidebar);
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
