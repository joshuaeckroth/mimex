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

function stripTrailingPunctuation(url) {
  return url.replace(/[),.;!?]+$/g, "");
}

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
      await selectNote(result.targetNoteId);
      setStatus(`Followed link to ${result.targetTitle ?? result.targetNoteId}`);
      return;
    }

    setStatus(`No match for "${target}"`, true);
  } catch (error) {
    setStatus(`Failed to follow link: ${error.message}`, true);
  }
}

function renderMarkdownInto(container, markdown, sourceNoteId) {
  const regex = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>()]+)/g;
  let idx = 0;

  for (const match of markdown.matchAll(regex)) {
    const start = match.index ?? 0;
    if (start > idx) {
      container.append(document.createTextNode(markdown.slice(idx, start)));
    }

    if (match[1]) {
      const target = match[1].trim();
      const anchor = document.createElement("a");
      anchor.href = "#";
      anchor.textContent = `[[${target}]]`;
      anchor.className = "internal-link";
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        void followInternalLink(sourceNoteId, target);
      });
      container.append(anchor);
      idx = start + match[0].length;
      continue;
    }

    if (match[2] && match[3]) {
      const label = match[2];
      const rawTarget = match[3].trim();
      const isInternal = rawTarget.toLowerCase().startsWith("note:");
      let target = rawTarget;
      if (isInternal) {
        try {
          target = decodeURIComponent(rawTarget.slice(5));
        } catch {
          target = rawTarget.slice(5);
        }
      }
      const anchor = document.createElement("a");
      anchor.textContent = label;
      if (isInternal) {
        anchor.href = "#";
        anchor.className = "internal-link";
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          void followInternalLink(sourceNoteId, target);
        });
      } else {
        anchor.href = rawTarget;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      }
      container.append(anchor);
      idx = start + match[0].length;
      continue;
    }

    const detected = stripTrailingPunctuation(match[4] ?? "");
    const tail = (match[4] ?? "").slice(detected.length);
    if (detected) {
      const anchor = document.createElement("a");
      anchor.href = detected;
      anchor.textContent = detected;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      container.append(anchor);
    }
    if (tail) {
      container.append(document.createTextNode(tail));
    }
    idx = start + match[0].length;
  }

  if (idx < markdown.length) {
    container.append(document.createTextNode(markdown.slice(idx)));
  }
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

  const h2 = document.createElement("h2");
  h2.textContent = note.note.title;

  const subline = document.createElement("div");
  subline.className = "detail-subline";
  subline.textContent = `${note.note.id} | updated ${formatDate(note.note.updatedAt)}${
    note.note.archivedAt ? " | archived" : ""
  }`;

  header.append(h2, subline);
  els.noteDetail.append(header);

  if (note.bodies.length === 0) {
    state.activeBodyIndex = 0;
    const empty = document.createElement("div");
    empty.className = "empty-msg";
    empty.textContent = "No bodies on this note.";
    els.noteDetail.append(empty);
    return;
  }

  state.activeBodyIndex = Math.max(0, Math.min(note.bodies.length - 1, state.activeBodyIndex));

  for (const [bodyIndex, body] of note.bodies.entries()) {
    const card = document.createElement("section");
    const isActiveBody = bodyIndex === state.activeBodyIndex;
    card.className = `body-card${isActiveBody ? " active" : ""}`;
    card.dataset.bodyIndex = String(bodyIndex);

    const label = document.createElement("div");
    label.className = "body-label";
    label.textContent = `${body.label} | ${formatDate(body.updatedAt)}`;
    label.addEventListener("click", () => {
      state.activeBodyIndex = bodyIndex;
      state.focusPane = "body";
      applyUiState();
      renderNoteDetail();
    });

    const bodyKey = `${note.note.id}:${body.id}`;
    const isEditing = state.editingBodyIds.has(bodyKey);
    const isSaving = state.savingBodyIds.has(bodyKey);

    const wrap = document.createElement("div");
    wrap.className = "body-editor-wrap";

    if (!isEditing) {
      const text = document.createElement("pre");
      text.className = "body-markdown";
      renderMarkdownInto(text, body.markdown, note.note.id);

      const actions = document.createElement("div");
      actions.className = "body-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "edit body";
      editBtn.disabled = isSaving;
      editBtn.addEventListener("click", () => {
        state.editingBodyIds.add(bodyKey);
        state.bodyDrafts.set(bodyKey, body.markdown);
        renderNoteDetail();
      });

      actions.append(editBtn);
      wrap.append(text, actions);
      card.append(label, wrap);
      els.noteDetail.append(card);
      continue;
    }

    if (!state.bodyDrafts.has(bodyKey)) {
      state.bodyDrafts.set(bodyKey, body.markdown);
    }
    const editor = document.createElement("textarea");
    editor.className = "body-editor";
    editor.value = state.bodyDrafts.get(bodyKey) ?? body.markdown;
    editor.setAttribute("spellcheck", "false");
    editor.disabled = isSaving;

    const actions = document.createElement("div");
    actions.className = "body-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.disabled = isSaving || editor.value === body.markdown;
    saveBtn.textContent = isSaving ? "saving..." : "save body";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "cancel";
    cancelBtn.disabled = isSaving;

    const saveState = document.createElement("span");
    saveState.className = "body-state";
    saveState.textContent = isSaving
      ? "Saving changes"
      : editor.value === body.markdown
        ? "No pending changes"
        : "Unsaved changes";

    async function persistBody() {
      const draft = editor.value;
      if (draft === body.markdown) {
        return;
      }

      let saved = false;
      state.savingBodyIds.add(bodyKey);
      renderNoteDetail();
      try {
        const updated = await saveBody(note.note.id, body.id, draft);
        state.editingBodyIds.delete(bodyKey);
        state.bodyDrafts.delete(bodyKey);
        setStatus(`Saved ${updated.note.title}`);
        saved = true;
      } catch (error) {
        setStatus(`Failed to save body: ${error.message}`, true);
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
      saveBtn.disabled = editor.value === body.markdown;
      saveState.textContent = editor.value === body.markdown ? "No pending changes" : "Unsaved changes";
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
    els.noteDetail.append(card);
  }
}

async function selectNote(noteId) {
  if (!noteId) {
    return;
  }

  state.selectedNoteId = noteId;
  if (isMobileViewport()) {
    state.sidebarOpen = false;
    applyUiState();
  }

  renderNoteList();
  setStatus("Loading note...");

  try {
    state.selectedNote = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}`);
    state.activeBodyIndex = 0;
    state.savingBodyIds.clear();
    state.editingBodyIds.clear();
    state.bodyDrafts.clear();
    renderNoteDetail();
    const bodyCount = state.selectedNote?.bodies?.length ?? 0;
    setStatus(`Loaded ${state.selectedNote.note.title} (${bodyCount} bodies)`);
  } catch (error) {
    state.selectedNote = null;
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

async function refreshList({ preserveSelection = true } = {}) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  setStatus("Loading notes...");

  try {
    await fetchList();

    const rows = listRows();
    const searching = els.searchInput.value.trim().length > 0;
    if (searching) {
      state.selectedNoteId = rows[0]?.id ?? null;
    } else {
      const selectedStillVisible = preserveSelection && rows.some((row) => row.id === state.selectedNoteId);
      if (!selectedStillVisible) {
        state.selectedNoteId = rows[0]?.id ?? null;
      }
    }

    renderNoteList();
    if (searching) {
      els.noteList.scrollTop = 0;
    }

    if (state.selectedNoteId) {
      await selectNote(state.selectedNoteId);
    } else {
      state.selectedNote = null;
      renderNoteDetail();
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
  state.bodyDrafts.set(bodyKey, body.markdown);
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
  void refreshList({ preserveSelection: false });
});

els.searchInput.addEventListener("input", () => {
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
void refreshList({ preserveSelection: false });
