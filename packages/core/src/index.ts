import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  AddBodyInput,
  CreateNoteInput,
  FollowLinkResult,
  HardLink,
  NoteBody,
  NoteBodyMeta,
  NoteMeta,
  NoteQueryOptions,
  NoteWithBodies,
  SearchResult,
  SoftLinkEvent,
  SoftLinkTarget
} from "@mimex/shared-types";

const NOTES_DIR = "notes";
const SYSTEM_DIR = ".mimex";
const SOFTLINKS_FILE = "softlinks.json";

interface SoftLinkStore {
  edges: Record<string, Record<string, number>>;
  events: SoftLinkEvent[];
}

export interface MimexCoreOptions {
  autoCommit?: boolean;
}

export class MimexCore {
  private readonly workspacePath: string;
  private readonly autoCommit: boolean;

  constructor(workspacePath: string, options: MimexCoreOptions = {}) {
    this.workspacePath = workspacePath;
    this.autoCommit = options.autoCommit ?? true;
  }

  async init(): Promise<void> {
    await mkdir(this.notesDir(), { recursive: true });
    await mkdir(this.systemDir(), { recursive: true });
    await this.ensureGitRepo();
  }

  async listNotes(options: NoteQueryOptions = {}): Promise<NoteMeta[]> {
    await this.init();
    const noteDirs = await this.getNoteDirectories();
    const notes: NoteMeta[] = [];

    for (const noteDir of noteDirs) {
      const note = await this.readNoteMeta(noteDir);
      if (note) {
        notes.push(note);
      }
    }

    const includeArchived = options.includeArchived ?? false;

    return notes
      .filter((note) => includeArchived || !isArchived(note))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createNote(input: CreateNoteInput): Promise<NoteWithBodies> {
    await this.init();
    const title = this.validateTitle(input.title);
    const existing = await this.findNoteByTitle(title, { includeArchived: true });

    if (existing) {
      if (isArchived(existing)) {
        await this.restoreNote(existing.id);
      }
      if (input.markdown && input.markdown.trim().length > 0) {
        await this.addBody({
          noteRef: existing.id,
          markdown: input.markdown,
          label: input.label
        });
      }
      return this.getNote(existing.id);
    }

    const now = new Date().toISOString();
    const noteId = await this.createUniqueNoteId(title);
    const noteDir = this.noteDir(noteId);
    const bodiesDir = this.bodiesDir(noteId);

    await mkdir(bodiesDir, { recursive: true });

    const note: NoteMeta = {
      id: noteId,
      title,
      aliases: this.normalizeAliases(input.aliases ?? []),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      bodies: []
    };

    if (input.markdown && input.markdown.trim().length > 0) {
      const bodyMeta = this.newBodyMeta(input.label ?? "main", now);
      note.bodies.push(bodyMeta);
      await writeFile(path.join(noteDir, "bodies", `${bodyMeta.id}.md`), input.markdown, "utf8");
    }

    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: create ${title}`);
    return this.getNote(note.id);
  }

  async addBody(input: AddBodyInput): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(input.noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${input.noteRef}`);
    }
    if (isArchived(note)) {
      throw new Error(`note is archived: ${note.title}`);
    }

    const now = new Date().toISOString();
    const body = this.newBodyMeta(input.label ?? `body-${note.bodies.length + 1}`, now);

    note.bodies.push(body);
    note.updatedAt = now;

    await writeFile(path.join(this.bodiesDir(note.id), `${body.id}.md`), input.markdown, "utf8");
    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: add body ${note.title}`);

    return this.getNote(note.id);
  }

  async archiveNote(noteRef: string): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${noteRef}`);
    }
    if (isArchived(note)) {
      return this.getNote(note.id);
    }

    note.archivedAt = new Date().toISOString();
    note.updatedAt = note.archivedAt;
    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: archive ${note.title}`);
    return this.getNote(note.id);
  }

  async restoreNote(noteRef: string): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${noteRef}`);
    }
    if (!isArchived(note)) {
      return this.getNote(note.id);
    }

    note.archivedAt = null;
    note.updatedAt = new Date().toISOString();
    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: restore ${note.title}`);
    return this.getNote(note.id);
  }

  async getNote(noteRef: string): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${noteRef}`);
    }

    const bodies: NoteBody[] = [];

    for (const bodyMeta of note.bodies) {
      const markdown = await readFile(path.join(this.bodiesDir(note.id), `${bodyMeta.id}.md`), "utf8");
      bodies.push({ ...bodyMeta, markdown });
    }

    return { note, bodies };
  }

  async searchNotes(query: string, limit = 10, options: NoteQueryOptions = {}): Promise<SearchResult[]> {
    await this.init();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const queryTokens = tokenize(normalizedQuery);
    const notes = await this.listNotes(options);
    const results: SearchResult[] = [];

    for (const note of notes) {
      const titleNorm = normalizeTitle(note.title);
      let score = 0;
      if (titleNorm === normalizeTitle(normalizedQuery)) {
        score += 100;
      }

      if (titleNorm.includes(normalizeTitle(normalizedQuery))) {
        score += 40;
      }

      for (const token of queryTokens) {
        if (titleNorm.includes(token)) {
          score += 15;
        }
      }

      let excerpt = "";
      const bodies = await this.readBodies(note.id, note.bodies);
      for (const body of bodies) {
        const bodyNorm = normalizeTitle(body.markdown);
        for (const token of queryTokens) {
          if (bodyNorm.includes(token)) {
            score += 3;
            if (!excerpt) {
              excerpt = this.findExcerpt(body.markdown, token);
            }
          }
        }
      }

      if (score > 0) {
        results.push({
          noteId: note.id,
          title: note.title,
          score,
          excerpt
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async parseHardLinks(noteRef: string): Promise<HardLink[]> {
    const note = await this.getNote(noteRef);
    const links = new Map<string, HardLink>();

    for (const body of note.bodies) {
      for (const link of extractHardLinks(body.markdown)) {
        links.set(link.normalized, link);
      }
    }

    return [...links.values()];
  }

  async followLink(sourceRef: string, targetHint: string): Promise<FollowLinkResult> {
    await this.init();
    const source = await this.resolveNoteRef(sourceRef, { includeArchived: false });

    if (!source) {
      throw new Error(`source note not found: ${sourceRef}`);
    }

    const directTarget = await this.resolveNoteRef(targetHint, { includeArchived: false });
    if (directTarget) {
      await this.incrementSoftLink(source.id, directTarget.id, "hard");
      return {
        sourceNoteId: source.id,
        targetNoteId: directTarget.id,
        targetTitle: directTarget.title,
        reason: "hard",
        candidates: []
      };
    }

    const candidates = (await this.searchNotes(targetHint, 5)).filter((candidate) => candidate.noteId !== source.id);
    if (candidates.length === 0) {
      return {
        sourceNoteId: source.id,
        targetNoteId: null,
        targetTitle: null,
        reason: null,
        candidates
      };
    }

    const best = candidates[0];
    await this.incrementSoftLink(source.id, best.noteId, "search");

    return {
      sourceNoteId: source.id,
      targetNoteId: best.noteId,
      targetTitle: best.title,
      reason: "search",
      candidates
    };
  }

  async getTopSoftLinks(noteRef: string, limit = 5): Promise<SoftLinkTarget[]> {
    await this.init();
    const note = await this.resolveNoteRef(noteRef, { includeArchived: false });
    if (!note) {
      throw new Error(`note not found: ${noteRef}`);
    }

    const store = await this.readSoftLinkStore();
    const srcEdges = store.edges[note.id] ?? {};
    const entries = Object.entries(srcEdges)
      .map(([noteId, weight]) => ({ noteId, weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);

    const allNotes = await this.listNotes({ includeArchived: true });
    const titleById = new Map(allNotes.map((n) => [n.id, n.title]));

    return entries.map((entry) => ({
      noteId: entry.noteId,
      title: titleById.get(entry.noteId) ?? entry.noteId,
      weight: entry.weight
    }));
  }

  private async incrementSoftLink(src: string, dst: string, reason: "hard" | "search"): Promise<void> {
    const store = await this.readSoftLinkStore();
    store.edges[src] ??= {};
    store.edges[src][dst] = (store.edges[src][dst] ?? 0) + 1;

    store.events.push({
      id: randomUUID(),
      src,
      dst,
      reason,
      delta: 1,
      ts: new Date().toISOString()
    });

    if (store.events.length > 10000) {
      store.events = store.events.slice(-5000);
    }

    await writeFile(this.softLinksPath(), JSON.stringify(store, null, 2), "utf8");
    await this.autoCommitWorkspace(`soft-link: ${src} -> ${dst}`);
  }

  private async readSoftLinkStore(): Promise<SoftLinkStore> {
    const filePath = this.softLinksPath();
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as SoftLinkStore;
      parsed.edges ??= {};
      parsed.events ??= [];
      return parsed;
    } catch {
      return { edges: {}, events: [] };
    }
  }

  private async readBodies(noteId: string, bodyMetas: NoteBodyMeta[]): Promise<NoteBody[]> {
    const out: NoteBody[] = [];
    for (const bodyMeta of bodyMetas) {
      const markdown = await readFile(path.join(this.bodiesDir(noteId), `${bodyMeta.id}.md`), "utf8");
      out.push({ ...bodyMeta, markdown });
    }
    return out;
  }

  private async findNoteByTitle(title: string, options: NoteQueryOptions = {}): Promise<NoteMeta | null> {
    const notes = await this.listNotes(options);
    const wanted = normalizeTitle(title);

    for (const note of notes) {
      if (normalizeTitle(note.title) === wanted) {
        return note;
      }
      if (note.aliases.some((alias) => normalizeTitle(alias) === wanted)) {
        return note;
      }
    }

    return null;
  }

  private async resolveNoteRef(noteRef: string, options: NoteQueryOptions = {}): Promise<NoteMeta | null> {
    const trimmed = noteRef.trim();
    if (!trimmed) {
      return null;
    }

    const byId = await this.readNoteMeta(trimmed);
    if (byId && ((options.includeArchived ?? false) || !isArchived(byId))) {
      return byId;
    }

    return this.findNoteByTitle(trimmed, options);
  }

  private async createUniqueNoteId(title: string): Promise<string> {
    const base = slugify(title);
    let candidate = base;
    let suffix = 2;
    while (await this.noteExists(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private async noteExists(noteId: string): Promise<boolean> {
    try {
      await stat(path.join(this.noteDir(noteId), "note.json"));
      return true;
    } catch {
      return false;
    }
  }

  private async getNoteDirectories(): Promise<string[]> {
    const entries = await readdir(this.notesDir(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  private async readNoteMeta(noteId: string): Promise<NoteMeta | null> {
    try {
      const raw = await readFile(path.join(this.noteDir(noteId), "note.json"), "utf8");
      const parsed = JSON.parse(raw) as NoteMeta;
      parsed.aliases ??= [];
      parsed.bodies ??= [];
      parsed.archivedAt ??= null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeNoteMeta(note: NoteMeta): Promise<void> {
    await mkdir(this.noteDir(note.id), { recursive: true });
    await mkdir(this.bodiesDir(note.id), { recursive: true });
    await writeFile(path.join(this.noteDir(note.id), "note.json"), JSON.stringify(note, null, 2), "utf8");
  }

  private newBodyMeta(label: string, now: string): NoteBodyMeta {
    const hash = createHash("sha1").update(`${randomUUID()}-${now}`).digest("hex");
    return {
      id: hash.slice(0, 12),
      label,
      createdAt: now,
      updatedAt: now
    };
  }

  private normalizeAliases(aliases: string[]): string[] {
    const uniq = new Set(
      aliases
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0)
    );
    return [...uniq];
  }

  private findExcerpt(markdown: string, token: string): string {
    const idx = normalizeTitle(markdown).indexOf(token);
    if (idx < 0) {
      return markdown.slice(0, 140);
    }
    const start = Math.max(0, idx - 40);
    const end = Math.min(markdown.length, idx + 100);
    return markdown.slice(start, end).replace(/\s+/g, " ").trim();
  }

  private validateTitle(title: string): string {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title is required");
    }
    return trimmed;
  }

  private notesDir(): string {
    return path.join(this.workspacePath, NOTES_DIR);
  }

  private noteDir(noteId: string): string {
    return path.join(this.notesDir(), noteId);
  }

  private bodiesDir(noteId: string): string {
    return path.join(this.noteDir(noteId), "bodies");
  }

  private systemDir(): string {
    return path.join(this.workspacePath, SYSTEM_DIR);
  }

  private softLinksPath(): string {
    return path.join(this.systemDir(), SOFTLINKS_FILE);
  }

  private async ensureGitRepo(): Promise<void> {
    if (await fileExists(path.join(this.workspacePath, ".git"))) {
      return;
    }
    this.runGit(["init"]);
  }

  private async autoCommitWorkspace(message: string): Promise<void> {
    if (!this.autoCommit) {
      return;
    }

    this.runGit(["add", "-A"]);
    const diffExit = this.runGit(["diff", "--cached", "--quiet"]);
    if (diffExit === 1) {
      this.runGit([
        "-c",
        "user.name=Mimex",
        "-c",
        "user.email=mimex@local",
        "commit",
        "-m",
        message
      ]);
    }
  }

  private runGit(args: string[]): number {
    const result = spawnSync("git", args, {
      cwd: this.workspacePath,
      encoding: "utf8"
    });

    if (result.error) {
      return -1;
    }

    return result.status ?? -1;
  }
}

function normalizeTitle(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(input: string): string[] {
  return normalizeTitle(input)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function slugify(input: string): string {
  const value = normalizeTitle(input).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return value || randomUUID().slice(0, 8);
}

function isArchived(note: NoteMeta): boolean {
  return Boolean(note.archivedAt);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function extractHardLinks(markdown: string): HardLink[] {
  const found = new Map<string, HardLink>();

  const wikilinks = [...markdown.matchAll(/\[\[([^\]]+)\]\]/g)];
  for (const match of wikilinks) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    found.set(normalizeTitle(raw), { raw, normalized: normalizeTitle(raw) });
  }

  const noteProtocolLinks = [...markdown.matchAll(/\[[^\]]+\]\(note:([^\)]+)\)/g)];
  for (const match of noteProtocolLinks) {
    const raw = decodeURIComponent((match[1] ?? "").trim());
    if (!raw) {
      continue;
    }
    found.set(normalizeTitle(raw), { raw, normalized: normalizeTitle(raw) });
  }

  return [...found.values()];
}
