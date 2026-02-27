import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
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
  SoftLinkTarget,
  DeleteBodyInput,
  MoveBodyInput,
  MoveBodyResult,
  RenameBodyInput,
  UpdateBodyInput
} from "@mimex/shared-types";

const NOTES_DIR = "notes";
const SYSTEM_DIR = ".mimex";
const SOFTLINKS_FILE = "softlinks.json";
const GIT_SETTINGS_FILE = "git.json";
const CORE_CACHE_VERSION = 1;

interface CoreCacheSnapshot {
  version: number;
  workspacePath: string;
  savedAt: string;
  notesAll: NoteMeta[];
}

interface SoftLinkStore {
  edges: Record<string, Record<string, number>>;
  events: SoftLinkEvent[];
}

interface SearchTerm {
  normalized: string;
  stem: string;
}

interface ParsedSearchQuery {
  normalized: string;
  phrases: string[];
  terms: SearchTerm[];
}

interface SearchFieldWeights {
  exactQuery: number;
  containsQuery: number;
  phrase: number;
  termExact: number;
  termPartial: number;
  allTerms: number;
  proximityMax: number;
}

interface SearchFieldMatch {
  score: number;
  matchedTerms: number;
}

interface NormalizedTextWithMap {
  text: string;
  map: number[];
}

const TITLE_SEARCH_WEIGHTS: SearchFieldWeights = {
  exactQuery: 160,
  containsQuery: 65,
  phrase: 48,
  termExact: 24,
  termPartial: 12,
  allTerms: 40,
  proximityMax: 22
};

const ALIAS_SEARCH_WEIGHTS: SearchFieldWeights = {
  exactQuery: 90,
  containsQuery: 40,
  phrase: 30,
  termExact: 14,
  termPartial: 8,
  allTerms: 22,
  proximityMax: 12
};

const BODY_SEARCH_WEIGHTS: SearchFieldWeights = {
  exactQuery: 55,
  containsQuery: 24,
  phrase: 16,
  termExact: 6,
  termPartial: 3,
  allTerms: 10,
  proximityMax: 8
};

export interface MimexCoreOptions {
  autoCommit?: boolean;
  cacheDir?: string;
  cacheMaxAgeMs?: number;
}

export type GitAuthMode = "ssh" | "https_pat";

export interface GitRemoteConfig {
  remoteUrl: string;
  branch: string;
  authMode: GitAuthMode;
  tokenRef: string | null;
  token: string | null;
}

export interface GitRemoteConfigUpdateInput {
  remoteUrl: string;
  branch?: string;
  authMode?: GitAuthMode;
  tokenRef?: string | null;
  token?: string | null;
}

export interface GitCommandOptions {
  token?: string | null;
}

export interface GitWorkspaceStatus {
  configured: boolean;
  remoteUrl: string | null;
  remoteBranch: string | null;
  authMode: GitAuthMode;
  tokenRef: string | null;
  hasAuth: boolean;
  currentBranch: string | null;
  dirty: boolean;
}

export class MimexCore {
  private readonly workspacePath: string;
  private readonly autoCommit: boolean;
  private readonly cacheDir: string;
  private readonly cacheFilePath: string;
  private readonly cacheMaxAgeMs: number;
  private initPromise: Promise<void> | null = null;
  private notesAllCache: NoteMeta[] | null = null;
  private notesCacheLoadedAtMs = 0;
  private notesByIdCache = new Map<string, NoteMeta>();
  private notesByTitleCache = new Map<string, NoteMeta>();
  private softLinkStoreCache: SoftLinkStore | null = null;
  private topSoftLinksCache = new Map<string, SoftLinkTarget[]>();

  constructor(workspacePath: string, options: MimexCoreOptions = {}) {
    this.workspacePath = path.resolve(workspacePath);
    this.autoCommit = options.autoCommit ?? true;
    this.cacheDir = options.cacheDir ?? resolveDefaultCacheDir();
    this.cacheMaxAgeMs = options.cacheMaxAgeMs ?? 30_000;
    const workspaceHash = createHash("sha1").update(this.workspacePath).digest("hex").slice(0, 16);
    this.cacheFilePath = path.join(this.cacheDir, workspaceHash, "core-cache.json");
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.notesDir(), { recursive: true });
    await mkdir(this.systemDir(), { recursive: true });
    await this.ensureGitRepo();
    await this.loadNotesCacheFromDisk();
  }

  async listNotes(options: NoteQueryOptions = {}): Promise<NoteMeta[]> {
    await this.init();
    await this.ensureNotesCache();
    const notes = this.notesAllCache ?? [];

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
    this.cacheNoteMeta(note);
    void this.persistNotesCache();
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
    this.cacheNoteMeta(note);
    void this.persistNotesCache();

    return this.getNote(note.id);
  }

  async updateBody(input: UpdateBodyInput): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(input.noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${input.noteRef}`);
    }
    if (isArchived(note)) {
      throw new Error(`note is archived: ${note.title}`);
    }

    const body = note.bodies.find((entry) => entry.id === input.bodyId);
    if (!body) {
      throw new Error(`body not found: ${input.bodyId}`);
    }

    const now = new Date().toISOString();
    body.updatedAt = now;
    note.updatedAt = now;

    await writeFile(path.join(this.bodiesDir(note.id), `${body.id}.md`), input.markdown, "utf8");
    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: update body ${note.title}`);
    this.cacheNoteMeta(note);
    void this.persistNotesCache();

    return this.getNote(note.id);
  }

  async renameBody(input: RenameBodyInput): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(input.noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${input.noteRef}`);
    }
    if (isArchived(note)) {
      throw new Error(`note is archived: ${note.title}`);
    }

    const body = note.bodies.find((entry) => entry.id === input.bodyId);
    if (!body) {
      throw new Error(`body not found: ${input.bodyId}`);
    }

    const nextLabel = this.validateBodyLabel(input.label);
    if (body.label === nextLabel) {
      return this.getNote(note.id);
    }

    const now = new Date().toISOString();
    body.label = nextLabel;
    body.updatedAt = now;
    note.updatedAt = now;

    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: rename body ${note.title} [${body.id}] -> ${nextLabel}`);
    this.cacheNoteMeta(note);
    void this.persistNotesCache();

    return this.getNote(note.id);
  }

  async deleteBody(input: DeleteBodyInput): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(input.noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${input.noteRef}`);
    }
    if (isArchived(note)) {
      throw new Error(`note is archived: ${note.title}`);
    }

    const bodyIndex = note.bodies.findIndex((entry) => entry.id === input.bodyId);
    if (bodyIndex < 0) {
      throw new Error(`body not found: ${input.bodyId}`);
    }

    note.bodies.splice(bodyIndex, 1);
    const now = new Date().toISOString();
    note.updatedAt = now;

    await rm(path.join(this.bodiesDir(note.id), `${input.bodyId}.md`), { force: true });
    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: delete body ${note.title} [${input.bodyId}]`);
    this.cacheNoteMeta(note);
    void this.persistNotesCache();

    return this.getNote(note.id);
  }

  async moveBody(input: MoveBodyInput): Promise<MoveBodyResult> {
    await this.init();
    const sourceNote = await this.resolveNoteRef(input.noteRef, { includeArchived: true });
    if (!sourceNote) {
      throw new Error(`note not found: ${input.noteRef}`);
    }
    if (isArchived(sourceNote)) {
      throw new Error(`note is archived: ${sourceNote.title}`);
    }

    const targetNote = await this.resolveNoteRef(input.targetNoteRef, { includeArchived: true });
    if (!targetNote) {
      throw new Error(`note not found: ${input.targetNoteRef}`);
    }
    if (isArchived(targetNote)) {
      throw new Error(`note is archived: ${targetNote.title}`);
    }
    if (sourceNote.id === targetNote.id) {
      throw new Error("source and target notes must be different");
    }

    const bodyIndex = sourceNote.bodies.findIndex((entry) => entry.id === input.bodyId);
    if (bodyIndex < 0) {
      throw new Error(`body not found: ${input.bodyId}`);
    }

    const [sourceBody] = sourceNote.bodies.splice(bodyIndex, 1);
    if (!sourceBody) {
      throw new Error(`body not found: ${input.bodyId}`);
    }

    const now = new Date().toISOString();
    let movedBodyId = sourceBody.id;
    if (targetNote.bodies.some((entry) => entry.id === movedBodyId)) {
      movedBodyId = randomUUID();
    }

    const movedBodyMeta: NoteBodyMeta = {
      ...sourceBody,
      id: movedBodyId,
      updatedAt: now
    };
    targetNote.bodies.push(movedBodyMeta);
    sourceNote.updatedAt = now;
    targetNote.updatedAt = now;

    const sourceBodyPath = path.join(this.bodiesDir(sourceNote.id), `${sourceBody.id}.md`);
    const targetBodyPath = path.join(this.bodiesDir(targetNote.id), `${movedBodyId}.md`);
    const markdown = await readFile(sourceBodyPath, "utf8");
    await writeFile(targetBodyPath, markdown, "utf8");
    await rm(sourceBodyPath, { force: true });

    await this.writeNoteMeta(sourceNote);
    await this.writeNoteMeta(targetNote);
    await this.autoCommitWorkspace(`note: move body ${sourceNote.title} [${sourceBody.id}] -> ${targetNote.title}`);
    this.cacheNoteMeta(sourceNote);
    this.cacheNoteMeta(targetNote);
    void this.persistNotesCache();

    const [source, target] = await Promise.all([this.getNote(sourceNote.id), this.getNote(targetNote.id)]);
    return {
      source,
      target,
      movedBodyId
    };
  }

  async renameNote(noteRef: string, title: string): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${noteRef}`);
    }
    if (isArchived(note)) {
      throw new Error(`note is archived: ${note.title}`);
    }

    const nextTitle = this.validateTitle(title);
    if (note.title === nextTitle) {
      return this.getNote(note.id);
    }

    const existing = await this.findNoteByTitle(nextTitle, { includeArchived: true });
    if (existing && existing.id !== note.id) {
      throw new Error(`note title already exists: ${nextTitle}`);
    }

    note.title = nextTitle;
    note.updatedAt = new Date().toISOString();
    await this.writeNoteMeta(note);
    await this.autoCommitWorkspace(`note: rename ${note.id} -> ${nextTitle}`);
    this.cacheNoteMeta(note);
    void this.persistNotesCache();
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
    this.cacheNoteMeta(note);
    void this.persistNotesCache();
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
    this.cacheNoteMeta(note);
    void this.persistNotesCache();
    return this.getNote(note.id);
  }

  async deleteNote(noteRef: string): Promise<NoteMeta> {
    await this.init();
    const note = await this.resolveNoteRef(noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${noteRef}`);
    }

    await rm(this.noteDir(note.id), { recursive: true, force: true });

    const store = await this.readSoftLinkStore();
    let changed = false;

    if (store.edges[note.id]) {
      delete store.edges[note.id];
      changed = true;
    }

    for (const [src, targets] of Object.entries(store.edges)) {
      if (targets[note.id] !== undefined) {
        delete targets[note.id];
        changed = true;
      }
      if (Object.keys(targets).length === 0) {
        delete store.edges[src];
        changed = true;
      }
    }

    const filteredEvents = store.events.filter((event) => event.src !== note.id && event.dst !== note.id);
    if (filteredEvents.length !== store.events.length) {
      store.events = filteredEvents;
      changed = true;
    }

    if (changed) {
      await writeFile(this.softLinksPath(), JSON.stringify(store, null, 2), "utf8");
    }

    await this.autoCommitWorkspace(`note: delete ${note.title}`);
    this.removeCachedNote(note.id);
    this.softLinkStoreCache = store;
    this.topSoftLinksCache.clear();
    void this.persistNotesCache();
    return note;
  }

  async getNote(noteRef: string): Promise<NoteWithBodies> {
    await this.init();
    const note = await this.resolveNoteRef(noteRef, { includeArchived: true });

    if (!note) {
      throw new Error(`note not found: ${noteRef}`);
    }

    const bodies = await this.readBodies(note.id, note.bodies);

    return { note, bodies };
  }

  async searchNotes(query: string, limit = 10, options: NoteQueryOptions = {}): Promise<SearchResult[]> {
    await this.init();
    const parsedQuery = parseSearchQuery(query);
    if (!parsedQuery.normalized) {
      return [];
    }

    const notes = await this.listNotes(options);
    const results: SearchResult[] = [];

    for (const note of notes) {
      let score = 0;
      score += scoreSearchField(note.title, parsedQuery, TITLE_SEARCH_WEIGHTS).score;
      for (const alias of note.aliases) {
        score += scoreSearchField(alias, parsedQuery, ALIAS_SEARCH_WEIGHTS).score;
      }

      let excerpt = "";
      let bestBodyScore = 0;
      const bodies = await this.readBodies(note.id, note.bodies);
      for (const body of bodies) {
        const bodyMatch = scoreSearchField(body.markdown, parsedQuery, BODY_SEARCH_WEIGHTS);
        score += bodyMatch.score;
        if (bodyMatch.score > bestBodyScore) {
          bestBodyScore = bodyMatch.score;
          excerpt = this.findExcerpt(body.markdown, parsedQuery);
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

    const cacheKey = `${note.id}:${limit}`;
    const cached = this.topSoftLinksCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const store = await this.readSoftLinkStore();
    const srcEdges = store.edges[note.id] ?? {};
    const entries = Object.entries(srcEdges)
      .map(([noteId, weight]) => ({ noteId, weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);

    const allNotes = await this.listNotes({ includeArchived: true });
    const titleById = new Map(allNotes.map((n) => [n.id, n.title]));

    const resolved = entries.map((entry) => ({
      noteId: entry.noteId,
      title: titleById.get(entry.noteId) ?? entry.noteId,
      weight: entry.weight
    }));
    this.topSoftLinksCache.set(cacheKey, resolved);
    return resolved;
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
    this.softLinkStoreCache = store;
    this.topSoftLinksCache.clear();
  }

  private async readSoftLinkStore(): Promise<SoftLinkStore> {
    if (this.softLinkStoreCache) {
      return this.softLinkStoreCache;
    }

    const filePath = this.softLinksPath();
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as SoftLinkStore;
      parsed.edges ??= {};
      parsed.events ??= [];
      this.softLinkStoreCache = parsed;
      return parsed;
    } catch {
      const empty = { edges: {}, events: [] };
      this.softLinkStoreCache = empty;
      return empty;
    }
  }

  private async readBodies(noteId: string, bodyMetas: NoteBodyMeta[]): Promise<NoteBody[]> {
    return Promise.all(
      bodyMetas.map(async (bodyMeta) => {
        const markdown = await readFile(path.join(this.bodiesDir(noteId), `${bodyMeta.id}.md`), "utf8");
        return { ...bodyMeta, markdown };
      })
    );
  }

  private async ensureNotesCache(): Promise<void> {
    if (this.notesAllCache) {
      if (this.cacheMaxAgeMs <= 0) {
        return;
      }
      if (Date.now() - this.notesCacheLoadedAtMs < this.cacheMaxAgeMs) {
        return;
      }
    }

    if (this.notesAllCache && this.cacheMaxAgeMs > 0) {
      await this.refreshNotesCacheFromWorkspace();
      return;
    }

    await this.refreshNotesCacheFromWorkspace();
  }

  private async loadNotesCacheFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.cacheFilePath, "utf8");
      const parsed = JSON.parse(raw) as CoreCacheSnapshot;
      if (parsed.version !== CORE_CACHE_VERSION || parsed.workspacePath !== this.workspacePath || !Array.isArray(parsed.notesAll)) {
        return;
      }

      const savedAtMs = Date.parse(parsed.savedAt);
      if (this.cacheMaxAgeMs > 0 && Number.isFinite(savedAtMs)) {
        const ageMs = Date.now() - savedAtMs;
        if (ageMs > this.cacheMaxAgeMs) {
          return;
        }
      }

      const normalized = parsed.notesAll.map((note) => normalizeNoteMeta(note));
      normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      this.primeNoteCaches(normalized);
    } catch {
      // cache is best-effort
    }
  }

  private async refreshNotesCacheFromWorkspace(): Promise<void> {
    const noteDirs = await this.getNoteDirectories();
    const loaded = await Promise.all(noteDirs.map((noteDir) => this.readNoteMeta(noteDir)));
    const notes = loaded.filter((note): note is NoteMeta => Boolean(note));
    notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.primeNoteCaches(notes);
    await this.persistNotesCache();
  }

  private primeNoteCaches(notes: NoteMeta[]): void {
    this.notesAllCache = notes;
    this.notesCacheLoadedAtMs = Date.now();
    this.notesByIdCache.clear();
    this.notesByTitleCache.clear();
    this.topSoftLinksCache.clear();

    for (const note of notes) {
      this.notesByIdCache.set(note.id, note);
      const titleKey = normalizeTitle(note.title);
      if (!this.notesByTitleCache.has(titleKey)) {
        this.notesByTitleCache.set(titleKey, note);
      }
      for (const alias of note.aliases) {
        const aliasKey = normalizeTitle(alias);
        if (!this.notesByTitleCache.has(aliasKey)) {
          this.notesByTitleCache.set(aliasKey, note);
        }
      }
    }
  }

  private cacheNoteMeta(note: NoteMeta): void {
    if (!this.notesAllCache) {
      return;
    }

    const current = this.notesAllCache ?? [];
    const without = current.filter((existing) => existing.id !== note.id);
    without.push(note);
    without.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.primeNoteCaches(without);
  }

  private removeCachedNote(noteId: string): void {
    if (!this.notesAllCache) {
      return;
    }

    const current = this.notesAllCache ?? [];
    const next = current.filter((existing) => existing.id !== noteId);
    this.primeNoteCaches(next);
  }

  private async persistNotesCache(): Promise<void> {
    if (!this.notesAllCache) {
      return;
    }

    const payload: CoreCacheSnapshot = {
      version: CORE_CACHE_VERSION,
      workspacePath: this.workspacePath,
      savedAt: new Date().toISOString(),
      notesAll: this.notesAllCache
    };

    try {
      await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
      await writeFile(this.cacheFilePath, JSON.stringify(payload), "utf8");
    } catch {
      // cache is best-effort
    }
  }

  private async findNoteByTitle(title: string, options: NoteQueryOptions = {}): Promise<NoteMeta | null> {
    const wanted = normalizeTitle(title);
    await this.ensureNotesCache();
    const matched = this.notesByTitleCache.get(wanted) ?? null;
    if (!matched) {
      return null;
    }
    if ((options.includeArchived ?? false) || !isArchived(matched)) {
      return matched;
    }
    return null;
  }

  private async resolveNoteRef(noteRef: string, options: NoteQueryOptions = {}): Promise<NoteMeta | null> {
    const trimmed = noteRef.trim();
    if (!trimmed) {
      return null;
    }
    await this.ensureNotesCache();

    const byId = this.notesByIdCache.get(trimmed);
    if (byId && ((options.includeArchived ?? false) || !isArchived(byId))) {
      return byId;
    }

    const byTitle = this.notesByTitleCache.get(normalizeTitle(trimmed));
    if (byTitle && ((options.includeArchived ?? false) || !isArchived(byTitle))) {
      return byTitle;
    }

    return null;
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
      return normalizeNoteMeta(JSON.parse(raw) as NoteMeta);
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

  private findExcerpt(markdown: string, query: ParsedSearchQuery): string {
    const normalized = normalizeSearchTextWithMap(markdown);
    const needles = [
      ...query.phrases,
      ...query.terms.map((term) => term.normalized),
      ...query.terms.map((term) => term.stem)
    ].filter(Boolean);

    let bestStart = -1;
    let bestLength = 0;

    for (const needle of needles) {
      const idx = normalized.text.indexOf(needle);
      if (idx < 0) {
        continue;
      }

      if (bestStart < 0 || idx < bestStart || (idx === bestStart && needle.length > bestLength)) {
        bestStart = idx;
        bestLength = needle.length;
      }
    }

    if (bestStart < 0 || normalized.map.length === 0) {
      return markdown.slice(0, 140).replace(/\s+/g, " ").trim();
    }

    const normEnd = Math.min(normalized.map.length - 1, bestStart + Math.max(1, bestLength) - 1);
    const originalStart = normalized.map[Math.min(bestStart, normalized.map.length - 1)] ?? 0;
    const originalEnd = normalized.map[normEnd] ?? originalStart;
    const start = Math.max(0, originalStart - 60);
    const end = Math.min(markdown.length, originalEnd + 120);
    const excerpt = markdown.slice(start, end).replace(/\s+/g, " ").trim();
    const prefix = start > 0 ? "..." : "";
    const suffix = end < markdown.length ? "..." : "";
    return `${prefix}${excerpt}${suffix}`;
  }

  private validateTitle(title: string): string {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title is required");
    }
    return trimmed;
  }

  private validateBodyLabel(label: string): string {
    const trimmed = label.trim();
    if (!trimmed) {
      throw new Error("body label is required");
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

  private gitSettingsPath(): string {
    return path.join(this.systemDir(), GIT_SETTINGS_FILE);
  }

  async getGitRemoteConfig(): Promise<GitRemoteConfig> {
    await this.init();
    return this.readGitRemoteConfig();
  }

  async updateGitRemoteConfig(input: GitRemoteConfigUpdateInput): Promise<GitRemoteConfig> {
    await this.init();

    const previous = await this.readGitRemoteConfig();
    const nextAuthMode = input.authMode ?? previous.authMode;
    const next: GitRemoteConfig = {
      remoteUrl: input.remoteUrl.trim(),
      branch: (input.branch ?? previous.branch).trim() || "main",
      authMode: nextAuthMode,
      tokenRef: null,
      token: null
    };

    if (next.authMode === "https_pat") {
      const tokenRef = input.tokenRef ?? previous.tokenRef ?? null;
      next.tokenRef = tokenRef && tokenRef.trim() ? tokenRef.trim() : null;

      const token = input.token ?? previous.token ?? null;
      next.token = token && token.trim() ? token.trim() : null;
    }

    await writeFile(this.gitSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  async getGitWorkspaceStatus(): Promise<GitWorkspaceStatus> {
    await this.init();
    const config = await this.readGitRemoteConfig();
    const branchResult = this.runGitWithOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
    const statusResult = this.runGitWithOutput(["status", "--porcelain"]);
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null;
    const dirty = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;
    const hasAuth = config.authMode === "ssh" ? true : Boolean((config.token ?? "").trim() || config.tokenRef);

    return {
      configured: config.remoteUrl.length > 0,
      remoteUrl: config.remoteUrl.length > 0 ? config.remoteUrl : null,
      remoteBranch: config.branch || null,
      authMode: config.authMode,
      tokenRef: config.tokenRef,
      hasAuth,
      currentBranch,
      dirty
    };
  }

  async gitPull(options: GitCommandOptions = {}): Promise<void> {
    await this.init();
    const config = await this.readGitRemoteConfig();
    this.assertGitRemoteConfigured(config);
    this.ensureOriginRemote(config.remoteUrl);

    const authArgs = this.resolveGitAuthArgs(config, options.token ?? null);
    const gitEnv = this.gitCommandEnv();
    this.runGitChecked([...authArgs, "fetch", "origin", config.branch], "git fetch failed", gitEnv);
    this.runGitChecked([...authArgs, "pull", "--rebase", "origin", config.branch], "git pull failed", gitEnv);
  }

  async gitPush(options: GitCommandOptions = {}): Promise<void> {
    await this.init();
    const config = await this.readGitRemoteConfig();
    this.assertGitRemoteConfigured(config);
    this.ensureOriginRemote(config.remoteUrl);

    const authArgs = this.resolveGitAuthArgs(config, options.token ?? null);
    const gitEnv = this.gitCommandEnv();
    this.runGitChecked([...authArgs, "push", "origin", `HEAD:${config.branch}`], "git push failed", gitEnv);
  }

  async gitSync(options: GitCommandOptions = {}): Promise<void> {
    await this.gitPull(options);
    await this.gitPush(options);
  }

  private assertGitRemoteConfigured(config: GitRemoteConfig): void {
    if (!config.remoteUrl) {
      throw new Error("git remote URL is not configured");
    }
    if (!config.branch) {
      throw new Error("git branch is not configured");
    }
  }

  private async readGitRemoteConfig(): Promise<GitRemoteConfig> {
    const settingsPath = this.gitSettingsPath();
    try {
      const raw = await readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<GitRemoteConfig>;
      const authMode = parsed.authMode === "https_pat" ? "https_pat" : "ssh";

      const normalized: GitRemoteConfig = {
        remoteUrl: typeof parsed.remoteUrl === "string" ? parsed.remoteUrl.trim() : "",
        branch: typeof parsed.branch === "string" && parsed.branch.trim() ? parsed.branch.trim() : "main",
        authMode,
        tokenRef: null,
        token: null
      };

      if (authMode === "https_pat") {
        normalized.tokenRef =
          typeof parsed.tokenRef === "string" && parsed.tokenRef.trim().length > 0 ? parsed.tokenRef.trim() : null;
        normalized.token = typeof parsed.token === "string" && parsed.token.trim().length > 0 ? parsed.token.trim() : null;
      }

      return normalized;
    } catch {
      return {
        remoteUrl: "",
        branch: "main",
        authMode: "ssh",
        tokenRef: null,
        token: null
      };
    }
  }

  private ensureOriginRemote(remoteUrl: string): void {
    const currentRemote = this.runGitWithOutput(["remote", "get-url", "origin"]);
    if (currentRemote.exitCode !== 0) {
      this.runGitChecked(["remote", "add", "origin", remoteUrl], "failed to add origin remote");
      return;
    }

    const existingUrl = currentRemote.stdout.trim();
    if (existingUrl !== remoteUrl) {
      this.runGitChecked(["remote", "set-url", "origin", remoteUrl], "failed to update origin remote");
    }
  }

  private resolveGitAuthArgs(config: GitRemoteConfig, tokenOverride: string | null): string[] {
    if (config.authMode !== "https_pat") {
      return [];
    }

    if (!/^https?:\/\//i.test(config.remoteUrl)) {
      throw new Error("https_pat auth mode requires an https remote URL");
    }

    const token = (tokenOverride ?? config.token ?? "").trim();
    if (!token) {
      throw new Error("HTTPS token is required");
    }

    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    return ["-c", `http.extraheader=AUTHORIZATION: basic ${basicAuth}`];
  }

  private gitCommandEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    };
  }

  private runGitChecked(args: string[], context: string, env?: NodeJS.ProcessEnv): string {
    const result = this.runGitWithOutput(args, env);
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || "unknown git error";
      throw new Error(`${context}: ${detail}`);
    }
    return result.stdout;
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

    if (this.runGit(["add", "-A"]) !== 0) {
      return;
    }
    const status = this.runGitWithOutput(["status", "--porcelain"]);
    if (status.exitCode === 0 && status.stdout.trim().length > 0) {
      this.runGit([
        "-c",
        "user.name=Mimex",
        "-c",
        "user.email=mimex@local",
        "commit",
        "--no-gpg-sign",
        "-m",
        message
      ]);
    }
  }

  private runGit(args: string[], env?: NodeJS.ProcessEnv): number {
    const result = spawnSync("git", args, {
      cwd: this.workspacePath,
      encoding: "utf8",
      env: env ?? process.env
    });
    if (typeof result.status === "number") {
      return result.status;
    }
    return -1;
  }

  private runGitWithOutput(args: string[], env?: NodeJS.ProcessEnv): { exitCode: number; stdout: string; stderr: string } {
    const result = spawnSync("git", args, {
      cwd: this.workspacePath,
      encoding: "utf8",
      env: env ?? process.env
    });
    const errorText = result.error?.message ?? "";
    return {
      exitCode: typeof result.status === "number" ? result.status : -1,
      stdout: result.stdout ?? "",
      stderr: `${result.stderr ?? ""}${errorText ? `\n${errorText}` : ""}`.trim()
    };
  }
}

function normalizeTitle(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeSearchText(input: string): string {
  return normalizeSearchTextWithMap(input).text;
}

function normalizeSearchTextWithMap(input: string): NormalizedTextWithMap {
  let normalized = "";
  const map: number[] = [];
  let sourceOffset = 0;
  let justWroteSpace = true;

  for (const sourceChar of input) {
    const sourceIndex = sourceOffset;
    sourceOffset += sourceChar.length;

    for (const part of sourceChar.normalize("NFKD")) {
      if (/\p{Mark}/u.test(part)) {
        continue;
      }

      const lower = part.toLowerCase();
      const isWordChar = /[\p{Letter}\p{Number}]/u.test(lower) || lower === "+" || lower === "#";
      if (isWordChar) {
        normalized += lower;
        map.push(sourceIndex);
        justWroteSpace = false;
        continue;
      }

      if (!justWroteSpace && normalized.length > 0) {
        normalized += " ";
        map.push(sourceIndex);
        justWroteSpace = true;
      }
    }
  }

  let start = 0;
  while (start < normalized.length && normalized[start] === " ") {
    start += 1;
  }

  let end = normalized.length;
  while (end > start && normalized[end - 1] === " ") {
    end -= 1;
  }

  return {
    text: normalized.slice(start, end),
    map: map.slice(start, end)
  };
}

function splitSearchTokens(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

function singularizeToken(token: string): string {
  if (token.length <= 3 || /[+#]/.test(token)) {
    return token;
  }

  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (/(sses|shes|ches|xes|zes)$/.test(token)) {
    return token.slice(0, -2);
  }

  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("is") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }

  return token;
}

function stemSearchToken(token: string): string {
  if (!token || /[+#]/.test(token)) {
    return token;
  }

  let stem = singularizeToken(token);
  const suffixes = ["ingly", "edly", "ments", "ment", "ness", "ation", "ing", "ed", "ly", "er"];

  for (const suffix of suffixes) {
    if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }

  if (stem.length > 3 && /(.)\1$/.test(stem)) {
    stem = stem.slice(0, -1);
  }

  return stem.length >= 2 ? stem : token;
}

function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const normalized = normalizeSearchText(rawQuery);
  if (!normalized) {
    return {
      normalized: "",
      phrases: [],
      terms: []
    };
  }

  const phraseSet = new Set<string>();
  const termSet = new Set<string>();
  let matchedAnyPart = false;

  for (const match of rawQuery.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    matchedAnyPart = true;
    const quoted = match[1] ?? match[2];
    const rawPart = (quoted ?? match[3] ?? "").trim();
    if (!rawPart) {
      continue;
    }

    const partNormalized = normalizeSearchText(rawPart);
    if (!partNormalized) {
      continue;
    }

    for (const token of splitSearchTokens(partNormalized)) {
      termSet.add(token);
    }

    if (quoted) {
      phraseSet.add(partNormalized);
    }
  }

  if (!matchedAnyPart) {
    for (const token of splitSearchTokens(normalized)) {
      termSet.add(token);
    }
  }

  if (normalized.includes(" ")) {
    phraseSet.add(normalized);
  }

  const terms: SearchTerm[] = [...termSet].map((token) => {
    const stem = stemSearchToken(token);
    return {
      normalized: token,
      stem: stem || token
    };
  });

  return {
    normalized,
    phrases: [...phraseSet],
    terms
  };
}

function scoreSearchField(field: string, query: ParsedSearchQuery, weights: SearchFieldWeights): SearchFieldMatch {
  const normalizedField = normalizeSearchText(field);
  if (!normalizedField) {
    return { score: 0, matchedTerms: 0 };
  }

  let score = 0;
  if (normalizedField === query.normalized) {
    score += weights.exactQuery;
  }
  if (normalizedField.includes(query.normalized)) {
    score += weights.containsQuery;
  }

  for (const phrase of query.phrases) {
    if (phrase && normalizedField.includes(phrase)) {
      score += weights.phrase;
    }
  }

  if (query.terms.length === 0) {
    return { score, matchedTerms: 0 };
  }

  const tokens = splitSearchTokens(normalizedField);
  if (tokens.length === 0) {
    return { score, matchedTerms: 0 };
  }

  const tokenStems = tokens.map((token) => stemSearchToken(token));
  let matchedTerms = 0;
  const matchedPositions: number[] = [];

  for (const term of query.terms) {
    let bestMatchType = 0;
    let bestPosition = -1;

    for (let idx = 0; idx < tokens.length; idx += 1) {
      const token = tokens[idx] ?? "";
      const tokenStem = tokenStems[idx] ?? token;
      const exact = token === term.normalized || tokenStem === term.stem;
      if (exact) {
        bestMatchType = 2;
        bestPosition = idx;
        break;
      }

      const partial =
        token.startsWith(term.normalized) ||
        tokenStem.startsWith(term.stem);

      if (partial && bestMatchType < 1) {
        bestMatchType = 1;
        bestPosition = idx;
      }
    }

    if (bestMatchType === 0 && normalizedField.includes(term.normalized)) {
      bestMatchType = 1;
    }

    if (bestMatchType > 0) {
      matchedTerms += 1;
      score += bestMatchType === 2 ? weights.termExact : weights.termPartial;
      if (bestPosition >= 0) {
        matchedPositions.push(bestPosition);
      }
    }
  }

  if (matchedTerms === query.terms.length) {
    score += weights.allTerms;
    if (matchedPositions.length >= 2) {
      const minPos = Math.min(...matchedPositions);
      const maxPos = Math.max(...matchedPositions);
      const span = maxPos - minPos + 1;
      score += Math.max(0, weights.proximityMax - span + 1);
    }
  }

  return { score, matchedTerms };
}

function slugify(input: string): string {
  const value = normalizeTitle(input).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return value || randomUUID().slice(0, 8);
}

function isArchived(note: NoteMeta): boolean {
  return Boolean(note.archivedAt);
}

function normalizeNoteMeta(note: NoteMeta): NoteMeta {
  const aliases = (note.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0);
  const bodies = (note.bodies ?? []).map((body) => ({
    ...body,
    label: body.label ?? "body",
    createdAt: body.createdAt ?? note.createdAt,
    updatedAt: body.updatedAt ?? note.updatedAt
  }));

  return {
    ...note,
    aliases,
    bodies,
    archivedAt: note.archivedAt ?? null
  };
}

function resolveDefaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "mimex");
  }
  return path.join(os.homedir(), ".cache", "mimex");
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
