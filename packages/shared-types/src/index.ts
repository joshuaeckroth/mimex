export interface NoteBodyMeta {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteMeta {
  id: string;
  title: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  bodies: NoteBodyMeta[];
}

export interface NoteBody extends NoteBodyMeta {
  markdown: string;
}

export interface NoteWithBodies {
  note: NoteMeta;
  bodies: NoteBody[];
}

export interface SearchResult {
  noteId: string;
  title: string;
  score: number;
  excerpt: string;
}

export interface HardLink {
  raw: string;
  normalized: string;
}

export type FollowReason = "hard" | "search";

export interface SoftLinkEvent {
  id: string;
  src: string;
  dst: string;
  reason: FollowReason;
  delta: number;
  ts: string;
}

export interface SoftLinkTarget {
  noteId: string;
  title: string;
  weight: number;
}

export interface FollowLinkResult {
  sourceNoteId: string;
  targetNoteId: string | null;
  targetTitle: string | null;
  reason: FollowReason | null;
  candidates: SearchResult[];
}

export interface CreateNoteInput {
  title: string;
  aliases?: string[];
  markdown?: string;
  label?: string;
}

export interface AddBodyInput {
  noteRef: string;
  markdown: string;
  label?: string;
}
