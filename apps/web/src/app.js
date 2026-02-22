const els = {
  userId: document.querySelector("#userId"),
  searchInput: document.querySelector("#searchInput"),
  includeArchived: document.querySelector("#includeArchived"),
  refreshBtn: document.querySelector("#refreshBtn"),
  statusText: document.querySelector("#statusText"),
  statusRow: document.querySelector(".status-row"),
  noteList: document.querySelector("#noteList"),
  noteDetail: document.querySelector("#noteDetail")
};

const state = {
  notes: [],
  searchResults: [],
  selectedNoteId: null,
  selectedNote: null,
  loading: false
};

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusRow.classList.toggle("error", isError);
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
    const errorMessage = typeof payload === "object" && payload && "error" in payload ? JSON.stringify(payload.error) : String(payload || res.statusText);
    throw new Error(errorMessage);
  }

  return payload;
}

function formatDate(ts) {
  if (!ts) return "-";
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
      void selectNote(row.id);
    });

    els.noteList.append(button);
  }
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
  subline.textContent = `${note.note.id} | updated ${formatDate(note.note.updatedAt)}${note.note.archivedAt ? " | archived" : ""}`;

  header.append(h2, subline);
  els.noteDetail.append(header);

  if (note.bodies.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-msg";
    empty.textContent = "No bodies on this note.";
    els.noteDetail.append(empty);
    return;
  }

  for (const body of note.bodies) {
    const card = document.createElement("section");
    card.className = "body-card";

    const label = document.createElement("div");
    label.className = "body-label";
    label.textContent = `${body.label} | ${formatDate(body.updatedAt)}`;

    const text = document.createElement("pre");
    text.className = "body-markdown";
    text.textContent = body.markdown;

    card.append(label, text);
    els.noteDetail.append(card);
  }
}

async function selectNote(noteId) {
  if (!noteId) {
    return;
  }

  state.selectedNoteId = noteId;
  renderNoteList();
  setStatus("Loading note...");

  try {
    state.selectedNote = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}`);
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
    const selectedStillVisible = preserveSelection && rows.some((row) => row.id === state.selectedNoteId);
    if (!selectedStillVisible) {
      state.selectedNoteId = rows[0]?.id ?? null;
    }

    renderNoteList();

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

void refreshList({ preserveSelection: false });
