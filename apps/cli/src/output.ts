import type {
  FollowLinkResult,
  HardLink,
  NoteMeta,
  NoteWithBodies,
  SearchResult,
  SoftLinkTarget
} from "@mimex/shared-types";

export function renderNote(noteWithBodies: NoteWithBodies): string {
  const { note, bodies } = noteWithBodies;
  const lines: string[] = [];

  lines.push(`${note.title} (${note.id})`);
  lines.push(`Status: ${note.archivedAt ? `archived at ${note.archivedAt}` : "active"}`);
  lines.push(`Updated: ${note.updatedAt}`);
  lines.push(`Aliases: ${note.aliases.length > 0 ? note.aliases.join(", ") : "-"}`);
  lines.push(`Bodies: ${bodies.length}`);

  for (const body of bodies) {
    lines.push(`- [${body.id}] ${body.label} | ${body.updatedAt}`);
    const preview = body.markdown.replace(/\s+/g, " ").trim().slice(0, 120);
    if (preview) {
      lines.push(`  ${preview}${body.markdown.length > 120 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}

export function renderNotesList(notes: NoteMeta[]): string {
  if (notes.length === 0) {
    return "No notes.";
  }

  return notes
    .map((note) => {
      const status = note.archivedAt ? "archived" : "active";
      return `${note.id.padEnd(24)} ${String(note.bodies.length).padStart(2)} bodies  ${status.padEnd(8)} ${note.title}`;
    })
    .join("\n");
}

export function renderSearch(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results.";
  }

  return results
    .map((result, idx) => {
      const excerpt = result.excerpt ? `\n   ${result.excerpt}` : "";
      return `${idx + 1}. ${result.title} (${result.noteId}) score=${result.score}${excerpt}`;
    })
    .join("\n");
}

export function renderHardLinks(links: HardLink[]): string {
  if (links.length === 0) {
    return "No hard links.";
  }

  return links.map((link, idx) => `${idx + 1}. ${link.raw}`).join("\n");
}

export function renderSoftLinks(links: SoftLinkTarget[]): string {
  if (links.length === 0) {
    return "No soft links yet.";
  }

  return links
    .map((link, idx) => `${idx + 1}. ${link.title} (${link.noteId}) weight=${link.weight}`)
    .join("\n");
}

export function renderFollowResult(result: FollowLinkResult): string {
  if (!result.targetNoteId) {
    return `No target found from ${result.sourceNoteId}.`;
  }

  const lines = [
    `Source: ${result.sourceNoteId}`,
    `Target: ${result.targetTitle} (${result.targetNoteId})`,
    `Reason: ${result.reason}`
  ];

  if (result.candidates.length > 0) {
    lines.push("Candidates:");
    for (const candidate of result.candidates) {
      lines.push(`- ${candidate.title} (${candidate.noteId}) score=${candidate.score}`);
    }
  }

  return lines.join("\n");
}

export interface LinkResolution {
  link: string;
  resolution: "hard" | "search" | "none";
  targetNoteId: string | null;
  targetTitle: string | null;
  candidates: SearchResult[];
}

export function renderLinkResolutions(rows: LinkResolution[]): string {
  if (rows.length === 0) {
    return "No hard links to resolve.";
  }

  return rows
    .map((row) => {
      const base = `${row.link} -> ${row.targetTitle ?? "<unresolved>"}${row.targetNoteId ? ` (${row.targetNoteId})` : ""} [${row.resolution}]`;
      if (row.candidates.length === 0) {
        return base;
      }
      const top = row.candidates
        .slice(0, 3)
        .map((candidate) => `${candidate.title}(${candidate.score})`)
        .join(", ");
      return `${base}\n  candidates: ${top}`;
    })
    .join("\n");
}

function esc(input: string | number | null | undefined): string {
  if (input === null || input === undefined) {
    return "";
  }
  return String(input).replace(/[\t\n\r]+/g, " ").trim();
}

export function porcelainNote(noteWithBodies: NoteWithBodies): string {
  const lines: string[] = [];
  const { note, bodies } = noteWithBodies;
  lines.push(["NOTE", note.id, note.title, note.updatedAt, note.archivedAt, note.aliases.join(",")].map(esc).join("\t"));
  for (const body of bodies) {
    lines.push(["BODY", body.id, body.label, body.updatedAt].map(esc).join("\t"));
  }
  return lines.join("\n");
}

export function porcelainNotesList(notes: NoteMeta[]): string {
  return notes
    .map((note) => ["NOTE", note.id, note.title, note.bodies.length, note.updatedAt, note.archivedAt].map(esc).join("\t"))
    .join("\n");
}

export function porcelainNoteDeleted(note: NoteMeta): string {
  return ["NOTE_DELETED", note.id, note.title].map(esc).join("\t");
}

export function porcelainSearch(results: SearchResult[]): string {
  return results
    .map((result, idx) => ["SEARCH", idx + 1, result.noteId, result.title, result.score].map(esc).join("\t"))
    .join("\n");
}

export function porcelainHardLinks(links: HardLink[]): string {
  return links.map((link) => ["HARDLINK", link.raw, link.normalized].map(esc).join("\t")).join("\n");
}

export function porcelainSoftLinks(links: SoftLinkTarget[]): string {
  return links
    .map((link) => ["SOFTLINK", link.noteId, link.title, link.weight].map(esc).join("\t"))
    .join("\n");
}

export function porcelainFollowResult(result: FollowLinkResult): string {
  const lines = [
    ["FOLLOW", result.sourceNoteId, result.targetNoteId, result.targetTitle, result.reason].map(esc).join("\t")
  ];

  for (const candidate of result.candidates) {
    lines.push(["CANDIDATE", candidate.noteId, candidate.title, candidate.score].map(esc).join("\t"));
  }

  return lines.join("\n");
}

export function porcelainLinkResolutions(rows: LinkResolution[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(["RESOLVE", row.link, row.resolution, row.targetNoteId, row.targetTitle].map(esc).join("\t"));
    for (const candidate of row.candidates) {
      lines.push(["CANDIDATE", candidate.noteId, candidate.title, candidate.score].map(esc).join("\t"));
    }
  }
  return lines.join("\n");
}
