export const EDIT_TITLE_PREFIX = "%% MIMEX_TITLE:";
export const EDIT_ERROR_MARKER = "MIMEX_EDIT_ERROR";
const EDIT_ERROR_LINE_RE = /^<!--\s*MIMEX_EDIT_ERROR:\s*.*-->$/;

export function parseHashState(rawHash) {
  const rawValue = typeof rawHash === "string" ? rawHash : "";
  const raw = rawValue.startsWith("#") ? rawValue.slice(1) : rawValue;
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

export function buildHashState({ noteId = null, query = "", includeArchived = false } = {}) {
  const params = new URLSearchParams();
  const trimmedQuery = String(query || "").trim();
  const trimmedNoteId = String(noteId || "").trim();

  if (trimmedQuery) {
    params.set("q", trimmedQuery);
  }
  if (includeArchived) {
    params.set("archived", "1");
  }
  if (trimmedNoteId) {
    params.set("note", trimmedNoteId);
  }

  return params.toString();
}

function sanitizeEditErrorMessage(message) {
  return String(message || "")
    .replace(/\r?\n/g, " ")
    .replace(/-->/g, "-- >")
    .trim();
}

export function formatEditableNoteContent(title, markdown, errorMessage) {
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

export function prependEditErrorComment(content, errorMessage) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const stripped = stripLeadingEditErrorComments(normalized);
  const comment = `<!-- ${EDIT_ERROR_MARKER}: ${sanitizeEditErrorMessage(errorMessage)} -->`;
  if (!stripped) {
    return `${comment}\n`;
  }
  return `${comment}\n${stripped}`;
}

export function parseEditedNoteContent(content) {
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

export function buildListRows({ query = "", searchResults = [], notes = [] } = {}) {
  if ((Array.isArray(searchResults) && searchResults.length > 0) || String(query || "").trim()) {
    return searchResults.map((result) => ({
      id: result.noteId,
      title: result.title,
      subtitle: `score ${result.score}`,
      archivedAt: null
    }));
  }

  return notes.map((note) => ({
    id: note.id,
    title: note.title,
    subtitle: `${note.bodies.length} bodies`,
    archivedAt: note.archivedAt
  }));
}
