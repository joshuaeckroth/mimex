#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import blessed from "neo-blessed";
import { extractHardLinks, MimexCore } from "@mimex/core";
import type { FollowLinkResult, HardLink, NoteMeta, NoteWithBodies, SoftLinkTarget } from "@mimex/shared-types";

type InputMode = "none" | "search" | "create" | "body" | "follow" | "confirmDelete";
type FocusPane = "notes" | "bodies";
type ThemeName = "dark" | "light";

interface CompletionCycle {
  seed: string;
  matches: string[];
  index: number;
}

interface NoteDetailsState {
  openedNote: NoteWithBodies | null;
  activeBodyIndex: number;
  hardLinks: HardLink[];
  softLinks: SoftLinkTarget[];
}

interface ResolvedNoteDetails {
  note: NoteWithBodies;
  hardLinks: HardLink[];
  softLinks: SoftLinkTarget[];
}

interface BodyRender {
  lines: string[];
  bodyStarts: number[];
  hardLinkHits: BodyHardLinkHit[];
}

interface BodyHardLinkHit {
  line: number;
  start: number;
  end: number;
  target: string;
}

interface MarkdownHardLinkHit {
  line: number;
  start: number;
  end: number;
  target: string;
}

interface MarkdownRender {
  lines: string[];
  hardLinkHits: MarkdownHardLinkHit[];
}

interface BodyScrollChange {
  offsetChanged: boolean;
  bodyIndexChanged: boolean;
}

interface BodyRenderCache {
  openedNote: NoteWithBodies | null;
  activeBodyIndex: number;
  hardLinks: HardLink[];
  softLinks: SoftLinkTarget[];
  pendingNoteTitle: string | null;
  includeSoftSummary: boolean;
  bodyTextWidth: number;
  themeName: ThemeName;
  render: BodyRender;
}

interface TuiState {
  theme: ThemeName;
  wideSoftLinks: boolean;
  includeArchived: boolean;
  searchQuery: string;
  notes: NoteMeta[];
  selectedIndex: number;
  details: NoteDetailsState;
  mode: InputMode;
  focusPane: FocusPane;
  status: string;
  inputValue: string;
  completionCycle: CompletionCycle | null;
  bodyScrollOffset: number;
  pendingDeleteNote: NoteMeta | null;
}

interface ThemePalette {
  headerBg: string;
  headerFg: string;
  footerBg: string;
  footerFg: string;
  notesBg: string;
  bodyBg: string;
  notesItemFg: string;
  bodyItemFg: string;
  notesSelectedFg: string;
  notesSelectedBg: string;
  bodySelectedFg: string;
  bodySelectedBg: string;
  borderFocused: string;
  borderBlurred: string;
  mdHeadingFg: string;
  mdQuoteFg: string;
  mdCodeFg: string;
  mdRuleFg: string;
  mdMetaFg: string;
  mdLinkFg: string;
}

const defaultWorkspace = process.env.MIMEX_WORKSPACE_PATH ?? path.resolve(process.cwd(), "data/workspaces/local");
const DEBUG = process.env.MIMEX_TUI_DEBUG === "1";
const DEBUG_FILE = process.env.MIMEX_TUI_DEBUG_FILE ?? path.join(os.tmpdir(), "mimex-tui-debug.log");
const THEME_ENV = process.env.MIMEX_TUI_THEME;
const KEY_HINTS =
  "Tab/Left/Right pane, j/k + g/G scroll, PgUp/PgDn + Ctrl+u/d page, [ ] body, w wide soft links, e edit, l less, click [[link]] follow, n new, b body, / search, f follow, a archive, r restore, D delete, x archived, t theme, s refresh, q quit";
const NOTES_RENDER_WINDOW_MULTIPLIER = 2;
const BODY_RENDER_WINDOW_MULTIPLIER = 2;

const THEMES: Record<ThemeName, ThemePalette> = {
  dark: {
    headerBg: "black",
    headerFg: "white",
    footerBg: "black",
    footerFg: "white",
    notesBg: "black",
    bodyBg: "black",
    notesItemFg: "white",
    bodyItemFg: "white",
    notesSelectedFg: "black",
    notesSelectedBg: "white",
    bodySelectedFg: "white",
    bodySelectedBg: "black",
    borderFocused: "white",
    borderBlurred: "gray",
    mdHeadingFg: "cyan",
    mdQuoteFg: "magenta",
    mdCodeFg: "yellow",
    mdRuleFg: "gray",
    mdMetaFg: "green",
    mdLinkFg: "cyan"
  },
  light: {
    headerBg: "white",
    headerFg: "black",
    footerBg: "white",
    footerFg: "black",
    notesBg: "white",
    bodyBg: "white",
    notesItemFg: "black",
    bodyItemFg: "gray",
    notesSelectedFg: "white",
    notesSelectedBg: "black",
    bodySelectedFg: "black",
    bodySelectedBg: "white",
    borderFocused: "black",
    borderBlurred: "gray",
    mdHeadingFg: "blue",
    mdQuoteFg: "magenta",
    mdCodeFg: "green",
    mdRuleFg: "gray",
    mdMetaFg: "black",
    mdLinkFg: "blue"
  }
};

function resolveInitialTheme(raw: string | undefined): ThemeName {
  if (!raw) {
    return "dark";
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "light") {
    return "light";
  }

  return "dark";
}

function debugLog(message: string): void {
  if (!DEBUG) {
    return;
  }

  try {
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // ignore debug log write failures
  }
}

function noteStatus(note: NoteMeta): string {
  return note.archivedAt ? "archived" : "active";
}

function promptForMode(mode: InputMode): string {
  switch (mode) {
    case "search":
      return "Search query";
    case "create":
      return "New note title";
    case "body":
      return "Body markdown";
    case "follow":
      return "Follow target";
    case "confirmDelete":
      return "Type DELETE to confirm permanent removal";
    default:
      return "";
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

function filterCompletionCandidates(values: string[], seed: string): string[] {
  const source = uniqueSorted(values);
  const query = seed.trim().toLowerCase();
  if (!query) {
    return source;
  }

  const startsWith = source.filter((value) => value.toLowerCase().startsWith(query));
  if (startsWith.length > 0) {
    return startsWith;
  }

  return source.filter((value) => value.toLowerCase().includes(query));
}

function truncateForWidth(input: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (input.length <= width) {
    return input;
  }

  if (width <= 1) {
    return input.slice(0, width);
  }

  return `${input.slice(0, width - 1)}…`;
}

function findPreferredWrapCut(input: string, width: number): number {
  const minWordCut = Math.floor(width * 0.5);
  const spacedCut = input.lastIndexOf(" ", width);
  if (spacedCut >= minWordCut) {
    return spacedCut;
  }

  // For long markdown URLs, prefer breaking after URL separators.
  const minUrlCut = Math.floor(width * 0.33);
  const urlWindow = input.slice(0, width + 1);
  const urlSeparator = /[\/?#&=._:%-]/g;
  let urlCut = -1;
  for (const match of urlWindow.matchAll(urlSeparator)) {
    urlCut = (match.index ?? -1) + 1;
  }
  if (urlCut >= minUrlCut) {
    return urlCut;
  }

  return Math.max(1, width);
}

function wrapToWidth(input: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  const normalized = input.replace(/\t/g, "    ");
  if (normalized.length <= safeWidth) {
    return [normalized];
  }

  const out: string[] = [];
  let rest = normalized;

  while (rest.length > safeWidth) {
    const cut = findPreferredWrapCut(rest, safeWidth);

    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  out.push(rest);
  return out;
}

function escapeBlessedTags(input: string): string {
  return input.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function colorizeLine(input: string, fg: string, bold = false): string {
  if (bold) {
    return `{bold}{${fg}-fg}${input}{/${fg}-fg}{/bold}`;
  }
  return `{${fg}-fg}${input}{/${fg}-fg}`;
}

function normalizeInlineMarkdown(input: string): string {
  return input
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_all, alt: string, url: string) => `image: ${alt || "untitled"} <${url}>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_all, label: string, url: string) => `${label} <${url}>`);
}

function styleLineWithHardLinks(
  plainLine: string,
  theme: ThemePalette,
  style?: { fg?: string; bold?: boolean }
): { styled: string; hits: Omit<MarkdownHardLinkHit, "line">[] } {
  const hardLinkPattern = /\[\[([^\]\n]+?)\]\]/g;
  const hits: Omit<MarkdownHardLinkHit, "line">[] = [];
  let styled = "";
  let cursor = 0;
  let scanIndex = 0;

  for (const match of plainLine.matchAll(hardLinkPattern)) {
    const raw = match[0] ?? "";
    const target = (match[1] ?? "").trim();
    const matchStart = match.index ?? 0;
    const before = plainLine.slice(scanIndex, matchStart);
    if (before.length > 0) {
      styled += escapeBlessedTags(before);
      cursor += before.length;
    }

    const escapedRaw = escapeBlessedTags(raw);
    styled += `{${theme.mdLinkFg}-fg}${escapedRaw}{/${theme.mdLinkFg}-fg}`;
    hits.push({
      start: cursor,
      end: cursor + raw.length,
      target: target || raw
    });
    cursor += raw.length;
    scanIndex = matchStart + raw.length;
  }

  const tail = plainLine.slice(scanIndex);
  if (tail.length > 0) {
    styled += escapeBlessedTags(tail);
  }

  if (style?.fg) {
    styled = `{${style.fg}-fg}${styled}{/${style.fg}-fg}`;
  }

  if (style?.bold) {
    styled = `{bold}${styled}{/bold}`;
  }

  return { styled, hits };
}

function pushWrappedMarkdown(
  lines: string[],
  hardLinkHits: MarkdownHardLinkHit[],
  prefix: string,
  text: string,
  width: number,
  theme: ThemePalette,
  style?: { fg?: string; bold?: boolean }
): void {
  const effectiveWidth = Math.max(8, width - prefix.length);
  const wrapped = wrapToWidth(text, effectiveWidth);

  for (const [index, chunk] of wrapped.entries()) {
    const line = `${index === 0 ? prefix : " ".repeat(prefix.length)}${chunk || " "}`;
    const rendered = styleLineWithHardLinks(line, theme, style);
    const lineIndex = lines.length;
    lines.push(rendered.styled);
    for (const hit of rendered.hits) {
      hardLinkHits.push({ line: lineIndex, ...hit });
    }
  }
}

function renderMarkdownForTui(markdown: string, width: number, theme: ThemePalette): MarkdownRender {
  const lines: string[] = [];
  const hardLinkHits: MarkdownHardLinkHit[] = [];
  let inCodeBlock = false;
  const maxRule = Math.max(8, Math.min(64, width - 2));

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\t/g, "    ");
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```|~~~)\s*([^`~\s]+)?\s*$/);

    if (fenceMatch) {
      if (!inCodeBlock) {
        const lang = fenceMatch[2] ? ` ${fenceMatch[2]}` : "";
        lines.push(colorizeLine(`  [code${lang}]`, theme.mdCodeFg, true));
      } else {
        lines.push(colorizeLine("  [/code]", theme.mdCodeFg, true));
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (trimmed.length === 0) {
      lines.push("");
      continue;
    }

    if (inCodeBlock) {
      pushWrappedMarkdown(lines, hardLinkHits, "    ", normalizeInlineMarkdown(line), width, theme, { fg: theme.mdCodeFg });
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const headingText = normalizeInlineMarkdown(heading[2].trim());
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }

      if (level <= 2) {
        pushWrappedMarkdown(lines, hardLinkHits, "  ", headingText, width, theme, { fg: theme.mdHeadingFg, bold: true });
        lines.push(colorizeLine(`  ${(level === 1 ? "=" : "-").repeat(maxRule)}`.slice(0, width), theme.mdHeadingFg));
        lines.push("");
      } else {
        pushWrappedMarkdown(lines, hardLinkHits, `  ${"#".repeat(level)} `, headingText, width, theme, {
          fg: theme.mdHeadingFg,
          bold: true
        });
      }
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      lines.push(colorizeLine(`  ${"-".repeat(maxRule)}`, theme.mdRuleFg));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      pushWrappedMarkdown(lines, hardLinkHits, "  | ", normalizeInlineMarkdown(quote[1].trim()), width, theme, { fg: theme.mdQuoteFg });
      continue;
    }

    const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      const indent = "  ".repeat(Math.floor(task[1].length / 2));
      const mark = task[2].toLowerCase() === "x" ? "[x]" : "[ ]";
      pushWrappedMarkdown(lines, hardLinkHits, `  ${indent}- ${mark} `, normalizeInlineMarkdown(task[3].trim()), width, theme, {
        fg: theme.mdMetaFg
      });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      const indent = "  ".repeat(Math.floor(bullet[1].length / 2));
      pushWrappedMarkdown(lines, hardLinkHits, `  ${indent}- `, normalizeInlineMarkdown(bullet[2].trim()), width, theme, {
        fg: theme.mdMetaFg
      });
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (ordered) {
      const indent = "  ".repeat(Math.floor(ordered[1].length / 2));
      pushWrappedMarkdown(lines, hardLinkHits, `  ${indent}${ordered[2]}. `, normalizeInlineMarkdown(ordered[3].trim()), width, theme, {
        fg: theme.mdMetaFg
      });
      continue;
    }

    pushWrappedMarkdown(lines, hardLinkHits, "  ", normalizeInlineMarkdown(line), width, theme);
  }

  return { lines, hardLinkHits };
}

function bodyIndexForLine(bodyStarts: number[], line: number): number {
  if (bodyStarts.length === 0) {
    return 0;
  }

  let selected = 0;
  for (const [index, start] of bodyStarts.entries()) {
    if (start <= line) {
      selected = index;
      continue;
    }
    break;
  }

  return selected;
}

function renderBodyBreakMarker(
  index: number,
  total: number,
  label: string,
  id: string,
  active: boolean,
  width: number,
  theme: ThemePalette
): string {
  const safeWidth = Math.max(8, width);
  const shortId = id.slice(0, 8);
  const markerText = `${active ? ">" : " "} [${index + 1}/${total}] ${label} (${shortId})`;
  const clippedText = truncateForWidth(markerText, safeWidth);
  const ruleWidth = Math.max(0, safeWidth - clippedText.length);
  const rule = "-".repeat(ruleWidth);

  const left = rule.length > 0 ? colorizeLine(rule, active ? theme.mdHeadingFg : theme.mdRuleFg) : "";
  const escapedText = escapeBlessedTags(clippedText);
  const right = active ? `{bold}${escapedText}{/bold}` : escapedText;
  return `${left}${right}`;
}

function renderSoftLinkCell(link: SoftLinkTarget, index: number, width: number): string {
  const numbered = `${index + 1}. ${link.title} (${link.weight})`;
  return truncateForWidth(numbered, Math.max(6, width)).padEnd(Math.max(6, width), " ");
}

function buildSoftLinksGrid(softLinks: SoftLinkTarget[], width: number): string[] {
  const safeWidth = Math.max(8, width);
  const top = softLinks.slice(0, 10);
  if (top.length === 0) {
    return ["(none)"];
  }

  if (safeWidth < 40) {
    return top.map((link, index) => truncateForWidth(`${index + 1}. ${link.title} (${link.weight})`, safeWidth));
  }

  const gap = "  ";
  const colWidth = Math.max(10, Math.floor((safeWidth - gap.length) / 2));
  const lines: string[] = [];
  for (let i = 0; i < top.length; i += 2) {
    const left = renderSoftLinkCell(top[i] as SoftLinkTarget, i, colWidth);
    const rightLink = top[i + 1];
    if (!rightLink) {
      lines.push(left.trimEnd());
      continue;
    }
    const right = renderSoftLinkCell(rightLink, i + 1, colWidth);
    lines.push(`${left}${gap}${right}`);
  }

  return lines;
}

function buildBodyRender(
  details: NoteDetailsState,
  bodyTextWidth: number,
  theme: ThemePalette,
  pendingNoteTitle: string | null,
  includeSoftSummary: boolean
): BodyRender {
  const { openedNote, activeBodyIndex, hardLinks, softLinks } = details;

  if (!openedNote) {
    if (pendingNoteTitle) {
      return {
        lines: [colorizeLine(escapeBlessedTags(pendingNoteTitle), theme.mdHeadingFg, true), "", "Loading note details..."],
        bodyStarts: [],
        hardLinkHits: []
      };
    }

    return {
      lines: includeSoftSummary ? ["Select a note.", "", "Hard links: 0", "Top soft: (none)"] : ["Select a note.", "", "Hard links: 0"],
      bodyStarts: [],
      hardLinkHits: []
    };
  }

  const lines: string[] = [];
  const bodyStarts: number[] = [];
  const hardLinkHits: BodyHardLinkHit[] = [];

  lines.push(colorizeLine(escapeBlessedTags(openedNote.note.title), theme.mdHeadingFg, true));
  lines.push(colorizeLine(`Status: ${noteStatus(openedNote.note)} | Bodies: ${openedNote.bodies.length}`, theme.mdMetaFg));
  lines.push("");

  if (openedNote.bodies.length === 0) {
    lines.push("(no bodies)");
  }

  for (const [index, body] of openedNote.bodies.entries()) {
    bodyStarts.push(lines.length);
    lines.push(
      renderBodyBreakMarker(index, openedNote.bodies.length, body.label, body.id, index === activeBodyIndex, bodyTextWidth, theme)
    );
    const markdownStart = lines.length;
    const markdownRender = renderMarkdownForTui(body.markdown, Math.max(20, bodyTextWidth - 2), theme);
    lines.push(...markdownRender.lines);
    for (const hit of markdownRender.hardLinkHits) {
      hardLinkHits.push({
        line: markdownStart + hit.line,
        start: hit.start,
        end: hit.end,
        target: hit.target
      });
    }
  }

  lines.push("");

  const hardLinksSummary =
    hardLinks.length === 0 ? "Hard links: 0" : `Hard links (${hardLinks.length}): ${hardLinks.slice(0, 8).map((link) => link.raw).join(", ")}`;
  for (const wrapped of wrapToWidth(hardLinksSummary, bodyTextWidth)) {
    lines.push(colorizeLine(escapeBlessedTags(wrapped), theme.mdMetaFg));
  }

  if (includeSoftSummary) {
    const softSummary =
      softLinks.length === 0
        ? "Top soft: (none)"
        : `Top soft: ${softLinks
            .slice(0, 8)
            .map((link) => `${link.title} (${link.weight})`)
            .join(", ")}`;
    for (const wrapped of wrapToWidth(softSummary, bodyTextWidth)) {
      lines.push(colorizeLine(escapeBlessedTags(wrapped), theme.mdMetaFg));
    }
  }

  return { lines, bodyStarts, hardLinkHits };
}

function main(): void {
  const core = new MimexCore(defaultWorkspace);
  const detailsCache = new Map<string, ResolvedNoteDetails>();

  const state: TuiState = {
    theme: resolveInitialTheme(THEME_ENV),
    wideSoftLinks: false,
    includeArchived: false,
    searchQuery: "",
    notes: [],
    selectedIndex: 0,
    details: {
      openedNote: null,
      activeBodyIndex: 0,
      hardLinks: [],
      softLinks: []
    },
    mode: "none",
    focusPane: "notes",
    status: "Starting...",
    inputValue: "",
    completionCycle: null,
    bodyScrollOffset: 0,
    pendingDeleteNote: null
  };

  let isBusy = false;
  let allNotes: NoteMeta[] = [];
  let unfilteredSelectedNoteId: string | null = null;
  let pendingNoteTitle: string | null = null;
  let detailLoadToken = 0;
  let lastBodyRender: BodyRender = { lines: [], bodyStarts: [], hardLinkHits: [] };
  let bodyRenderCache: BodyRenderCache | null = null;
  let notesWindowSource: NoteMeta[] | null = null;
  let notesWindowStart = 0;
  let notesWindowEnd = 0;
  let bodyWindowRender: BodyRender | null = null;
  let bodyWindowStart = 0;
  let bodyWindowEnd = 0;
  let lastBodyViewport = 1;
  let lastWideSoftLinksVisible = false;
  let lastSoftLinksTextWidth = 0;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    title: "mimex"
  });

  const header = blessed.box({
    top: 0,
    left: 0,
    height: 1,
    width: "100%",
    tags: false,
    style: {
      bg: THEMES[state.theme].headerBg,
      fg: THEMES[state.theme].headerFg
    }
  });

  const notesList = blessed.list({
    top: 1,
    left: 0,
    width: 48,
    height: 20,
    border: "line",
    label: " Notes ",
    mouse: true,
    keys: false,
    vi: false,
    tags: false,
    scrollable: true,
    alwaysScroll: false,
    style: {
      bg: THEMES[state.theme].notesBg,
      border: { fg: THEMES[state.theme].borderBlurred },
      selected: { fg: THEMES[state.theme].notesSelectedFg, bg: THEMES[state.theme].notesSelectedBg },
      item: { fg: THEMES[state.theme].notesItemFg, bg: THEMES[state.theme].notesBg }
    },
    scrollbar: {
      ch: " "
    }
  });

  const bodyList = blessed.list({
    top: 1,
    left: 48,
    width: 72,
    height: 20,
    border: "line",
    label: " Bodies ",
    mouse: true,
    keys: false,
    vi: false,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      bg: THEMES[state.theme].bodyBg,
      border: { fg: THEMES[state.theme].borderBlurred },
      selected: { fg: THEMES[state.theme].bodySelectedFg, bg: THEMES[state.theme].bodySelectedBg },
      item: { fg: THEMES[state.theme].bodyItemFg, bg: THEMES[state.theme].bodyBg }
    },
    scrollbar: {
      ch: " "
    }
  });

  const softLinksBox = blessed.box({
    top: 1,
    left: 120,
    width: 30,
    height: 20,
    border: "line",
    label: " Soft Links ",
    tags: false,
    hidden: true,
    style: {
      bg: THEMES[state.theme].bodyBg,
      fg: THEMES[state.theme].bodyItemFg,
      border: { fg: THEMES[state.theme].borderBlurred }
    }
  });

  const footer = blessed.box({
    bottom: 0,
    left: 0,
    height: 2,
    width: "100%",
    tags: false,
    style: {
      bg: THEMES[state.theme].footerBg,
      fg: THEMES[state.theme].footerFg
    }
  });

  screen.append(header);
  screen.append(notesList);
  screen.append(bodyList);
  screen.append(softLinksBox);
  screen.append(footer);

  function getTerminalRows(): number {
    const fromScreen = typeof screen.height === "number" ? screen.height : Number.parseInt(String(screen.height), 10);
    if (Number.isFinite(fromScreen) && fromScreen > 0) {
      return fromScreen;
    }

    return process.stdout.rows ?? 24;
  }

  function getTerminalCols(): number {
    const fromScreen = typeof screen.width === "number" ? screen.width : Number.parseInt(String(screen.width), 10);
    if (Number.isFinite(fromScreen) && fromScreen > 0) {
      return fromScreen;
    }

    return process.stdout.columns ?? 120;
  }

  function getSelectedNote(): NoteMeta | null {
    return state.notes[state.selectedIndex] ?? null;
  }

  function setStatus(message: string): void {
    state.status = message;
  }

  function rememberUnfilteredSelection(noteId?: string | null): void {
    if (state.searchQuery) {
      return;
    }

    if (typeof noteId === "string") {
      unfilteredSelectedNoteId = noteId;
      return;
    }

    unfilteredSelectedNoteId = getSelectedNote()?.id ?? null;
  }

  function applyResolvedDetails(resolved: ResolvedNoteDetails): void {
    pendingNoteTitle = null;
    const previousNoteId = state.details.openedNote?.note.id;
    const noteChanged = previousNoteId !== resolved.note.note.id;

    const nextBodyIndex = resolved.note.bodies.length === 0 ? 0 : Math.max(0, Math.min(state.details.activeBodyIndex, resolved.note.bodies.length - 1));

    state.details = {
      openedNote: resolved.note,
      activeBodyIndex: nextBodyIndex,
      hardLinks: resolved.hardLinks,
      softLinks: resolved.softLinks
    };

    if (noteChanged) {
      state.bodyScrollOffset = 0;
    }
  }

  function setPendingNoteDetails(note: NoteMeta | null): void {
    if (!note) {
      pendingNoteTitle = null;
      return;
    }

    pendingNoteTitle = note.title;
    state.details = {
      openedNote: null,
      activeBodyIndex: 0,
      hardLinks: [],
      softLinks: []
    };
    state.bodyScrollOffset = 0;
  }

  async function fetchResolvedDetails(noteRef: string, force = false): Promise<ResolvedNoteDetails> {
    if (!force) {
      const cached = detailsCache.get(noteRef);
      if (cached) {
        return cached;
      }
    }

    const [note, soft] = await Promise.all([core.getNote(noteRef), core.getTopSoftLinks(noteRef, 8)]);
    const linksByNormalized = new Map<string, HardLink>();

    for (const body of note.bodies) {
      for (const link of extractHardLinks(body.markdown)) {
        linksByNormalized.set(link.normalized, link);
      }
    }

    const resolved: ResolvedNoteDetails = {
      note,
      hardLinks: [...linksByNormalized.values()],
      softLinks: soft
    };

    detailsCache.set(note.note.id, resolved);
    return resolved;
  }

  function prefetchDetails(noteIds: string[]): void {
    for (const noteId of noteIds) {
      if (detailsCache.has(noteId)) {
        continue;
      }

      void (async () => {
        try {
          await fetchResolvedDetails(noteId, false);
        } catch {
          // ignore prefetch failures
        }
      })();
    }
  }

  async function loadDetails(noteRef: string, token: number, force = false): Promise<void> {
    try {
      const resolved = await fetchResolvedDetails(noteRef, force);
      if (token !== detailLoadToken) {
        return;
      }

      applyResolvedDetails(resolved);
      renderUI();
    } catch (error) {
      if (token !== detailLoadToken) {
        return;
      }

      pendingNoteTitle = null;
      setStatus(`Error: ${(error as Error).message}`);
      renderUI();
    }
  }

  async function filterNotesBySearch(
    listed: NoteMeta[],
    query: string,
    includeArchivedValue: boolean
  ): Promise<NoteMeta[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return listed;
    }

    const results = await core.searchNotes(normalizedQuery, Math.max(25, listed.length), {
      includeArchived: includeArchivedValue
    });
    if (results.length === 0) {
      return [];
    }

    const notesById = new Map(listed.map((note) => [note.id, note] as const));
    const filtered: NoteMeta[] = [];
    for (const result of results) {
      const note = notesById.get(result.noteId);
      if (note) {
        filtered.push(note);
      }
    }

    return filtered;
  }

  async function refresh(
    preferredId?: string,
    includeArchivedValue = state.includeArchived,
    selectFirst = false
  ): Promise<void> {
    setStatus("Refreshing notes...");
    renderUI();

    const previousId = selectFirst ? undefined : preferredId ?? getSelectedNote()?.id;
    const listed = await core.listNotes({ includeArchived: includeArchivedValue });
    const filtered = await filterNotesBySearch(listed, state.searchQuery, includeArchivedValue);

    allNotes = listed;
    state.includeArchived = includeArchivedValue;
    state.notes = filtered;
    detailsCache.clear();

    if (listed.length === 0) {
      pendingNoteTitle = null;
      state.selectedIndex = 0;
      state.details = {
        openedNote: null,
        activeBodyIndex: 0,
        hardLinks: [],
        softLinks: []
      };
      state.bodyScrollOffset = 0;
      unfilteredSelectedNoteId = null;
      setStatus("No notes yet. Press n to create one.");
      renderUI();
      return;
    }

    if (filtered.length === 0) {
      pendingNoteTitle = null;
      state.selectedIndex = 0;
      state.details = {
        openedNote: null,
        activeBodyIndex: 0,
        hardLinks: [],
        softLinks: []
      };
      state.bodyScrollOffset = 0;
      setStatus(`No matches for "${state.searchQuery}"`);
      renderUI();
      return;
    }

    let nextIndex = 0;
    if (!selectFirst && previousId) {
      const found = filtered.findIndex((note) => note.id === previousId);
      if (found >= 0) {
        nextIndex = found;
      }
    }

    state.selectedIndex = nextIndex;

    const selectedNote = filtered[nextIndex];
    if (selectedNote) {
      rememberUnfilteredSelection(selectedNote.id);
      const token = detailLoadToken + 1;
      detailLoadToken = token;
      setPendingNoteDetails(selectedNote);
      await loadDetails(selectedNote.id, token, true);

      prefetchDetails(
        filtered
          .map((note) => note.id)
          .filter((id) => id !== selectedNote.id)
      );
    }

    if (state.searchQuery) {
      setStatus(`Loaded ${filtered.length}/${listed.length} matching notes`);
    } else {
      setStatus(`Loaded ${listed.length} notes`);
    }
    renderUI();
  }

  async function followAndShow(sourceId: string, target: string): Promise<void> {
    const result: FollowLinkResult = await core.followLink(sourceId, target);
    if (result.targetNoteId) {
      await refresh(result.targetNoteId);
      setStatus(`Followed ${result.reason} link to ${result.targetTitle}`);
      return;
    }

    setStatus("No target found");
  }

  async function editCurrentBodyInEditor(): Promise<void> {
    const openedNote = state.details.openedNote;
    if (!openedNote) {
      setStatus("No note selected");
      return;
    }

    if (openedNote.note.archivedAt) {
      setStatus("Cannot edit archived note");
      return;
    }

    let body = openedNote.bodies[state.details.activeBodyIndex];
    if (!body) {
      const created = await core.addBody({
        noteRef: openedNote.note.id,
        label: "main",
        markdown: ""
      });
      detailsCache.delete(openedNote.note.id);
      body = created.bodies[0];
      await refresh(openedNote.note.id);
    }

    if (!body) {
      setStatus("Unable to initialize body");
      return;
    }

    const editor = process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mimex-edit-"));
    const tmpPath = path.join(tmpDir, `${openedNote.note.id}-${body.id}.md`);

    try {
      await writeFile(tmpPath, body.markdown, "utf8");
      setStatus(`Opening editor (${editor})...`);
      renderUI();

      const screenWithAlt = screen as blessed.Widgets.Screen & { leave?: () => void; enter?: () => void };
      screenWithAlt.leave?.();
      const child = spawnSync(editor, [tmpPath], {
        stdio: "inherit",
        shell: true
      });
      screenWithAlt.enter?.();

      if (child.error) {
        throw child.error;
      }

      const edited = await readFile(tmpPath, "utf8");
      if (edited === body.markdown) {
        setStatus("No changes saved");
        renderUI();
        return;
      }

      await core.updateBody({
        noteRef: openedNote.note.id,
        bodyId: body.id,
        markdown: edited
      });

      detailsCache.delete(openedNote.note.id);
      await refresh(openedNote.note.id);
      setStatus(`Saved body ${body.label}`);
      renderUI();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function showCurrentBodyInLess(): Promise<void> {
    const openedNote = state.details.openedNote;
    if (!openedNote) {
      setStatus("No note selected");
      return;
    }

    const body = openedNote.bodies[state.details.activeBodyIndex];
    if (!body) {
      setStatus("No note body selected");
      return;
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mimex-less-"));
    const tmpPath = path.join(tmpDir, `${openedNote.note.id}-${body.id}.md`);

    try {
      await writeFile(tmpPath, body.markdown, "utf8");
      setStatus("Opening less...");
      renderUI();

      const screenWithAlt = screen as blessed.Widgets.Screen & { leave?: () => void; enter?: () => void };
      screenWithAlt.leave?.();
      const child = spawnSync("less", [tmpPath], {
        stdio: "inherit",
        shell: true
      });
      screenWithAlt.enter?.();

      if (child.error) {
        throw child.error;
      }

      setStatus(`Viewed raw body ${body.label} in less`);
      renderUI();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  function completionCandidatesForMode(mode: InputMode): string[] {
    const completionSource = allNotes.length > 0 ? allNotes : state.notes;
    const titleAndAlias = uniqueSorted(completionSource.flatMap((note) => [note.title, ...note.aliases]));
    const noteRefs = uniqueSorted(completionSource.flatMap((note) => [note.id, note.title, ...note.aliases]));
    const hardLinks = uniqueSorted(state.details.hardLinks.map((link) => link.raw));

    if (mode === "search") {
      return [...hardLinks, ...titleAndAlias];
    }

    if (mode === "follow") {
      return [...hardLinks, ...noteRefs];
    }

    if (mode === "create") {
      return titleAndAlias;
    }

    return [];
  }

  function advanceCompletion(): void {
    if (state.mode === "none") {
      return;
    }

    const allowCycle =
      state.completionCycle &&
      (state.inputValue === state.completionCycle.seed || state.completionCycle.matches.includes(state.inputValue));

    if (!allowCycle) {
      const matches = filterCompletionCandidates(completionCandidatesForMode(state.mode), state.inputValue);
      if (matches.length === 0) {
        setStatus("No completion candidates");
        return;
      }

      state.inputValue = matches[0] ?? state.inputValue;
      state.completionCycle = {
        seed: state.inputValue,
        matches,
        index: 0
      };
      setStatus(`Completion 1/${matches.length}`);
      return;
    }

    const cycle = state.completionCycle;
    if (!cycle) {
      return;
    }

    const nextIndex = (cycle.index + 1) % cycle.matches.length;
    const nextValue = cycle.matches[nextIndex] ?? state.inputValue;
    state.inputValue = nextValue;
    state.completionCycle = {
      ...cycle,
      index: nextIndex
    };
    setStatus(`Completion ${nextIndex + 1}/${cycle.matches.length}`);
  }

  function setBodyScroll(next: number): BodyScrollChange {
    const previousOffset = state.bodyScrollOffset;
    const previousBodyIndex = state.details.activeBodyIndex;
    const maxBodyScroll = Math.max(0, lastBodyRender.lines.length - lastBodyViewport);
    const clamped = Math.max(0, Math.min(maxBodyScroll, next));
    state.bodyScrollOffset = clamped;

    if ((state.details.openedNote?.bodies.length ?? 0) > 0) {
      state.details.activeBodyIndex = bodyIndexForLine(lastBodyRender.bodyStarts, clamped);
    }

    return {
      offsetChanged: previousOffset !== state.bodyScrollOffset,
      bodyIndexChanged: previousBodyIndex !== state.details.activeBodyIndex
    };
  }

  function scrollBodyBy(delta: number): void {
    if (!state.details.openedNote || state.details.openedNote.bodies.length === 0) {
      setStatus("No note bodies to scroll");
      renderFooterOnly();
      return;
    }

    const change = setBodyScroll(state.bodyScrollOffset + delta);
    if (change.bodyIndexChanged) {
      renderUI();
      return;
    }

    if (change.offsetChanged) {
      renderBodyViewportOnly();
    }
  }

  function jumpToBodyIndex(targetIndex: number): void {
    const openedNote = state.details.openedNote;
    if (!openedNote || openedNote.bodies.length === 0) {
      setStatus("No note bodies");
      renderUI();
      return;
    }

    const index = Math.max(0, Math.min(openedNote.bodies.length - 1, targetIndex));
    state.details.activeBodyIndex = index;
    state.focusPane = "bodies";

    const startLine = lastBodyRender.bodyStarts[index] ?? 0;
    setBodyScroll(startLine);
    renderUI();
  }

  function moveSelectedNoteBy(delta: number): void {
    if (state.notes.length === 0) {
      return;
    }

    const next = Math.max(0, Math.min(state.notes.length - 1, state.selectedIndex + delta));
    if (next === state.selectedIndex) {
      return;
    }

    state.selectedIndex = next;
    const nextId = state.notes[next]?.id;
    if (!nextId) {
      renderUI();
      return;
    }
    rememberUnfilteredSelection(nextId);

    const cached = detailsCache.get(nextId);
    if (cached) {
      applyResolvedDetails(cached);
      renderUI();
      return;
    }

    const token = detailLoadToken + 1;
    detailLoadToken = token;
    setPendingNoteDetails(state.notes[next] ?? null);
    setStatus("Loading note...");
    renderUI();
    void loadDetails(nextId, token);
  }

  async function submitInput(): Promise<void> {
    const value = state.inputValue.trim();
    const currentMode = state.mode;
    const pendingDeleteNote = state.pendingDeleteNote;

    state.mode = "none";
    state.inputValue = "";
    state.completionCycle = null;
    state.pendingDeleteNote = null;

    if (currentMode === "confirmDelete") {
      if (!pendingDeleteNote) {
        setStatus("No note selected");
        renderUI();
        return;
      }

      if (value !== "DELETE") {
        setStatus(`Delete cancelled for ${pendingDeleteNote.title}`);
        renderUI();
        return;
      }

      await core.deleteNote(pendingDeleteNote.id);
      detailsCache.delete(pendingDeleteNote.id);
      await refresh();
      setStatus(`Deleted ${pendingDeleteNote.title}`);
      renderUI();
      return;
    }

    if (currentMode === "search") {
      const sourceNoteId = state.details.openedNote?.note.id ?? null;
      const previousSearchQuery = state.searchQuery;
      if (value && sourceNoteId) {
        try {
          await core.followLink(sourceNoteId, value);
        } catch {
          // keep search UX responsive even if soft-link update fails
        }
      }
      if (!value) {
        const restoreId = unfilteredSelectedNoteId ?? undefined;
        state.searchQuery = "";
        await refresh(restoreId);
      } else {
        if (!previousSearchQuery) {
          rememberUnfilteredSelection();
        }
        state.searchQuery = value;
        await refresh(undefined, state.includeArchived, true);
      }
      if (!value) {
        setStatus("Search cleared");
      } else if (state.notes.length === 0) {
        setStatus(`No matches for "${value}"`);
      } else {
        setStatus(`Search matched ${state.notes.length} notes`);
      }
      renderUI();
      return;
    }

    if (!value) {
      setStatus("Cancelled empty input");
      renderUI();
      return;
    }

    if (currentMode === "create") {
      const created = await core.createNote({ title: value });
      await refresh(created.note.id);
      setStatus(`Created ${created.note.title}`);
      renderUI();
      return;
    }

    if (currentMode === "body") {
      const selected = getSelectedNote();
      if (!selected) {
        setStatus("No note selected");
        renderUI();
        return;
      }

      await core.addBody({ noteRef: selected.id, markdown: value, label: `body-${Date.now()}` });
      detailsCache.delete(selected.id);
      await refresh(selected.id);
      setStatus("Added body");
      renderUI();
      return;
    }

    if (currentMode === "follow") {
      const selected = getSelectedNote();
      if (!selected) {
        setStatus("No note selected");
        renderUI();
        return;
      }

      await followAndShow(selected.id, value);
      renderUI();
    }
  }

  async function runAction(task: () => Promise<void>): Promise<void> {
    if (isBusy) {
      setStatus("Busy...");
      renderUI();
      return;
    }

    isBusy = true;
    try {
      await task();
    } catch (error) {
      setStatus(`Error: ${(error as Error).message}`);
      renderUI();
    } finally {
      isBusy = false;
    }
  }

  function modeLineForWidth(cols: number): string {
    return state.mode === "none"
      ? truncateForWidth(KEY_HINTS, cols)
      : truncateForWidth(`${promptForMode(state.mode)}: ${state.inputValue}_  (Tab completion, Enter submit, Esc cancel)`, cols);
  }

  function setFooterContent(cols: number): void {
    const statusLine = truncateForWidth(state.status, cols);
    footer.setContent(`${statusLine}\n${modeLineForWidth(cols)}`);
  }

  function applyPaneChrome(theme: ThemePalette): void {
    notesList.style.border = { fg: state.focusPane === "notes" ? theme.borderFocused : theme.borderBlurred };
    bodyList.style.border = { fg: state.focusPane === "bodies" ? theme.borderFocused : theme.borderBlurred };
    softLinksBox.style.border = { fg: state.focusPane === "bodies" ? theme.borderFocused : theme.borderBlurred };
    notesList.setLabel(` Notes${state.focusPane === "notes" ? " (focus)" : ""} `);
  }

  function updateSoftLinksWideDisplay(visible: boolean, textWidth: number): void {
    softLinksBox.hidden = !visible;
    if (!visible) {
      return;
    }

    const links = state.details.softLinks.slice(0, 10);
    const lines = buildSoftLinksGrid(links, textWidth);
    softLinksBox.setContent(lines.join("\n"));
    softLinksBox.setLabel(
      ` Soft Links${state.focusPane === "bodies" ? " (focus)" : ""} ${links.length}/${state.details.softLinks.length} `
    );
  }

  function resolveNotesWindow(totalItems: number, viewportItems: number, selectedIndex: number): { start: number; end: number } {
    if (totalItems <= 0) {
      return { start: 0, end: 0 };
    }

    const windowSize = Math.max(viewportItems, Math.min(totalItems, viewportItems * NOTES_RENDER_WINDOW_MULTIPLIER));
    const maxStart = Math.max(0, totalItems - windowSize);
    const centeredStart = selectedIndex - Math.floor((windowSize - viewportItems) / 2);
    const start = Math.max(0, Math.min(maxStart, centeredStart));
    return { start, end: Math.min(totalItems, start + windowSize) };
  }

  function syncNotesWindowItems(viewportItems: number): void {
    const totalItems = state.notes.length;
    if (totalItems === 0) {
      if (notesWindowSource !== state.notes || notesWindowStart !== 0 || notesWindowEnd !== 0) {
        notesList.setItems(["(no notes)"]);
        notesWindowSource = state.notes;
        notesWindowStart = 0;
        notesWindowEnd = 0;
      }
      return;
    }

    const windowSize = Math.max(viewportItems, Math.min(totalItems, viewportItems * NOTES_RENDER_WINDOW_MULTIPLIER));
    const existingWindowSize = notesWindowEnd - notesWindowStart;
    const withinExistingWindow =
      notesWindowSource === state.notes &&
      existingWindowSize === windowSize &&
      state.selectedIndex >= notesWindowStart &&
      state.selectedIndex < notesWindowEnd;

    if (withinExistingWindow) {
      return;
    }

    const windowRange = resolveNotesWindow(totalItems, viewportItems, state.selectedIndex);
    const items = state.notes
      .slice(windowRange.start, windowRange.end)
      .map((note) => `${note.title}${note.archivedAt ? " [archived]" : ""}`);
    notesList.setItems(items);
    notesWindowSource = state.notes;
    notesWindowStart = windowRange.start;
    notesWindowEnd = windowRange.end;
  }

  function updateNotesViewportDisplay(): void {
    const notesViewport = Math.max(1, (typeof notesList.height === "number" ? notesList.height : 10) - 2);

    if (state.notes.length === 0) {
      state.selectedIndex = 0;
      syncNotesWindowItems(notesViewport);
      notesList.select(0);
      return;
    }

    state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, state.notes.length - 1));
    syncNotesWindowItems(notesViewport);

    const totalWindowItems = Math.max(0, notesWindowEnd - notesWindowStart);
    if (totalWindowItems > 0) {
      const localIndex = Math.max(0, Math.min(totalWindowItems - 1, state.selectedIndex - notesWindowStart));
      notesList.select(localIndex);
    } else {
      notesList.select(0);
    }
  }

  function resolveBodyWindow(totalLines: number, viewportLines: number, scrollOffset: number): { start: number; end: number } {
    if (totalLines <= 0) {
      return { start: 0, end: 0 };
    }

    const windowSize = Math.max(viewportLines, Math.min(totalLines, viewportLines * BODY_RENDER_WINDOW_MULTIPLIER));
    const maxStart = Math.max(0, totalLines - windowSize);
    const centeredStart = scrollOffset - Math.floor((windowSize - viewportLines) / 2);
    const start = Math.max(0, Math.min(maxStart, centeredStart));
    return { start, end: Math.min(totalLines, start + windowSize) };
  }

  function syncBodyWindowItems(viewportLines: number): void {
    const totalLines = lastBodyRender.lines.length;
    if (totalLines === 0) {
      if (bodyWindowRender !== lastBodyRender || bodyWindowStart !== 0 || bodyWindowEnd !== 0) {
        bodyList.setItems([""]);
        bodyWindowRender = lastBodyRender;
        bodyWindowStart = 0;
        bodyWindowEnd = 0;
      }
      return;
    }

    const windowSize = Math.max(viewportLines, Math.min(totalLines, viewportLines * BODY_RENDER_WINDOW_MULTIPLIER));
    const visibleStart = state.bodyScrollOffset;
    const visibleEnd = Math.min(totalLines, visibleStart + viewportLines);
    const existingWindowSize = bodyWindowEnd - bodyWindowStart;
    const withinExistingWindow =
      bodyWindowRender === lastBodyRender &&
      existingWindowSize === windowSize &&
      visibleStart >= bodyWindowStart &&
      visibleEnd <= bodyWindowEnd;

    if (withinExistingWindow) {
      return;
    }

    const windowRange = resolveBodyWindow(totalLines, viewportLines, visibleStart);
    bodyList.setItems(lastBodyRender.lines.slice(windowRange.start, windowRange.end));
    bodyWindowRender = lastBodyRender;
    bodyWindowStart = windowRange.start;
    bodyWindowEnd = windowRange.end;
  }

  function updateBodyViewportDisplay(): void {
    const bodyViewport = Math.max(1, (typeof bodyList.height === "number" ? bodyList.height : 10) - 2);
    lastBodyViewport = bodyViewport;

    const maxBodyScroll = Math.max(0, lastBodyRender.lines.length - bodyViewport);
    state.bodyScrollOffset = Math.max(0, Math.min(maxBodyScroll, state.bodyScrollOffset));

    syncBodyWindowItems(bodyViewport);

    const totalWindowLines = Math.max(0, bodyWindowEnd - bodyWindowStart);
    if (totalWindowLines > 0) {
      const localOffset = Math.max(0, Math.min(totalWindowLines - 1, state.bodyScrollOffset - bodyWindowStart));
      bodyList.select(localOffset);
      bodyList.scrollTo(localOffset);
    } else {
      bodyList.select(0);
      bodyList.scrollTo(0);
    }

    const visibleStart = lastBodyRender.lines.length === 0 ? 0 : state.bodyScrollOffset + 1;
    const visibleEnd = Math.min(state.bodyScrollOffset + bodyViewport, lastBodyRender.lines.length);
    bodyList.setLabel(
      ` Bodies${state.focusPane === "bodies" ? " (focus)" : ""} lines ${visibleStart}-${visibleEnd}/${lastBodyRender.lines.length} `
    );
  }

  function renderFooterOnly(): void {
    const cols = Math.max(80, getTerminalCols());
    footer.width = cols;
    setFooterContent(cols);
    screen.render();
  }

  function renderPaneChromeOnly(): void {
    const theme = THEMES[state.theme];
    applyPaneChrome(theme);
    updateBodyViewportDisplay();
    updateSoftLinksWideDisplay(lastWideSoftLinksVisible, lastSoftLinksTextWidth);

    const cols = Math.max(80, getTerminalCols());
    setFooterContent(cols);
    screen.render();
  }

  function renderBodyViewportOnly(): void {
    updateBodyViewportDisplay();

    const cols = Math.max(80, getTerminalCols());
    setFooterContent(cols);
    screen.render();
  }

  function resolveBodyRender(bodyTextWidth: number, theme: ThemePalette, includeSoftSummary: boolean): BodyRender {
    const cached = bodyRenderCache;
    if (
      cached &&
      cached.openedNote === state.details.openedNote &&
      cached.activeBodyIndex === state.details.activeBodyIndex &&
      cached.hardLinks === state.details.hardLinks &&
      cached.softLinks === state.details.softLinks &&
      cached.pendingNoteTitle === pendingNoteTitle &&
      cached.includeSoftSummary === includeSoftSummary &&
      cached.bodyTextWidth === bodyTextWidth &&
      cached.themeName === state.theme
    ) {
      return cached.render;
    }

    const render = buildBodyRender(state.details, bodyTextWidth, theme, pendingNoteTitle, includeSoftSummary);
    bodyRenderCache = {
      openedNote: state.details.openedNote,
      activeBodyIndex: state.details.activeBodyIndex,
      hardLinks: state.details.hardLinks,
      softLinks: state.details.softLinks,
      pendingNoteTitle,
      includeSoftSummary,
      bodyTextWidth,
      themeName: state.theme,
      render
    };

    return render;
  }

  function renderUI(): void {
    const rows = Math.max(12, getTerminalRows());
    const cols = Math.max(80, getTerminalCols());

    const footerHeight = 2;
    const contentHeight = Math.max(6, rows - 1 - footerHeight);
    const notesWidth = Math.max(30, Math.floor(cols * 0.42));
    const bodyPaneWidth = Math.max(40, cols - notesWidth);
    let softLinksPaneWidth = 0;
    if (state.wideSoftLinks) {
      const desired = Math.max(20, Math.min(42, Math.floor(bodyPaneWidth * 0.34)));
      softLinksPaneWidth = desired;
      if (bodyPaneWidth - softLinksPaneWidth < 24) {
        softLinksPaneWidth = Math.max(0, bodyPaneWidth - 24);
      }
    }
    const wideSoftLinksVisible = softLinksPaneWidth > 0;
    const bodyWidth = Math.max(24, bodyPaneWidth - softLinksPaneWidth);

    header.width = cols;

    notesList.top = 1;
    notesList.left = 0;
    notesList.width = notesWidth;
    notesList.height = contentHeight;

    bodyList.top = 1;
    bodyList.left = notesWidth;
    bodyList.width = bodyWidth;
    bodyList.height = contentHeight;

    softLinksBox.top = 1;
    softLinksBox.left = notesWidth + bodyWidth;
    softLinksBox.width = Math.max(1, softLinksPaneWidth);
    softLinksBox.height = contentHeight;

    footer.height = footerHeight;
    footer.width = cols;
    const theme = THEMES[state.theme];
    header.style = { bg: theme.headerBg, fg: theme.headerFg };
    footer.style = { bg: theme.footerBg, fg: theme.footerFg };
    notesList.style.bg = theme.notesBg;
    bodyList.style.bg = theme.bodyBg;
    notesList.style.fg = theme.notesItemFg;
    bodyList.style.fg = theme.bodyItemFg;
    notesList.style.selected = { fg: theme.notesSelectedFg, bg: theme.notesSelectedBg };
    bodyList.style.selected = { fg: theme.bodySelectedFg, bg: theme.bodySelectedBg };
    notesList.style.item = { fg: theme.notesItemFg, bg: theme.notesBg };
    bodyList.style.item = { fg: theme.bodyItemFg, bg: theme.bodyBg };
    softLinksBox.style.bg = theme.bodyBg;
    softLinksBox.style.fg = theme.bodyItemFg;

    const selected = getSelectedNote();
    const notesMetric = state.searchQuery ? `${state.notes.length}/${allNotes.length}` : `${state.notes.length}`;
    const searchMetric = state.searchQuery ? `  filter="${state.searchQuery}"` : "";
    header.setContent(
      truncateForWidth(
        `mimex TUI  theme=${state.theme}  workspace=${defaultWorkspace}  notes=${notesMetric}  ${state.includeArchived ? "all" : "active"}${searchMetric}  ${isBusy ? "busy" : "ready"}`,
        cols
      )
    );

    applyPaneChrome(theme);
    updateNotesViewportDisplay();

    const bodyTextWidth = Math.max(20, bodyWidth - 4);
    const bodyRender = resolveBodyRender(bodyTextWidth, theme, !wideSoftLinksVisible);
    lastBodyRender = bodyRender;

    updateBodyViewportDisplay();
    const softLinksTextWidth = Math.max(8, softLinksPaneWidth - 2);
    lastWideSoftLinksVisible = wideSoftLinksVisible;
    lastSoftLinksTextWidth = softLinksTextWidth;
    updateSoftLinksWideDisplay(wideSoftLinksVisible, softLinksTextWidth);
    setFooterContent(cols);

    if (selected) {
      debugLog(
        `render selected=${selected.id} focus=${state.focusPane} mode=${state.mode} theme=${state.theme} bodyScroll=${state.bodyScrollOffset} lines=${bodyRender.lines.length}`
      );
    }

    screen.render();
  }

  function enterInputMode(mode: InputMode, statusMessage: string): void {
    state.mode = mode;
    state.inputValue = "";
    state.completionCycle = null;
    setStatus(statusMessage);
    renderFooterOnly();
  }

  function handleInputMode(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void {
    if (key.name === "escape") {
      state.mode = "none";
      state.inputValue = "";
      state.completionCycle = null;
      state.pendingDeleteNote = null;
      setStatus("Input cancelled");
      renderFooterOnly();
      return;
    }

    if (key.name === "tab") {
      if (state.mode === "confirmDelete") {
        return;
      }

      advanceCompletion();
      renderFooterOnly();
      return;
    }

    if (key.name === "enter" || key.name === "return") {
      void runAction(async () => {
        await submitInput();
      });
      return;
    }

    if (key.ctrl && key.name === "u") {
      state.inputValue = "";
      state.completionCycle = null;
      renderFooterOnly();
      return;
    }

    if (key.name === "backspace" || key.name === "delete") {
      state.inputValue = state.inputValue.slice(0, -1);
      state.completionCycle = null;
      renderFooterOnly();
      return;
    }

    if (!key.ctrl && !key.meta && typeof ch === "string" && ch.length > 0) {
      state.inputValue += ch;
      state.completionCycle = null;
      renderFooterOnly();
    }
  }

  function handleMainKey(ch: string, key: blessed.Widgets.Events.IKeyEventArg): void {
    if (ch === "q") {
      screen.destroy();
      process.exit(0);
      return;
    }

    if (key.name === "tab") {
      state.focusPane = state.focusPane === "notes" ? "bodies" : "notes";
      renderPaneChromeOnly();
      return;
    }

    if (key.name === "left") {
      if (state.focusPane !== "notes") {
        state.focusPane = "notes";
        renderPaneChromeOnly();
      }
      return;
    }

    if (key.name === "right") {
      if (state.focusPane !== "bodies") {
        state.focusPane = "bodies";
        renderPaneChromeOnly();
      }
      return;
    }

    const notesViewport = Math.max(1, (typeof notesList.height === "number" ? notesList.height : 10) - 2);
    const bodyViewport = Math.max(1, lastBodyViewport);

    if (key.name === "pageup" || key.name === "prior") {
      if (state.focusPane === "notes") {
        moveSelectedNoteBy(-Math.max(1, notesViewport - 1));
      } else {
        scrollBodyBy(-Math.max(1, bodyViewport - 1));
      }
      return;
    }

    if (key.name === "pagedown" || key.name === "next") {
      if (state.focusPane === "notes") {
        moveSelectedNoteBy(Math.max(1, notesViewport - 1));
      } else {
        scrollBodyBy(Math.max(1, bodyViewport - 1));
      }
      return;
    }

    if ((key.ctrl && key.name === "d") || ch === "J") {
      if (state.focusPane === "notes") {
        moveSelectedNoteBy(Math.max(1, Math.floor(notesViewport / 2)));
      } else {
        scrollBodyBy(Math.max(1, Math.floor(bodyViewport / 2)));
      }
      return;
    }

    if ((key.ctrl && key.name === "u") || ch === "K") {
      if (state.focusPane === "notes") {
        moveSelectedNoteBy(-Math.max(1, Math.floor(notesViewport / 2)));
      } else {
        scrollBodyBy(-Math.max(1, Math.floor(bodyViewport / 2)));
      }
      return;
    }

    if (ch === "k" || key.name === "up") {
      if (state.focusPane === "notes") {
        moveSelectedNoteBy(-1);
      } else {
        scrollBodyBy(-1);
      }
      return;
    }

    if (ch === "j" || key.name === "down") {
      if (state.focusPane === "notes") {
        moveSelectedNoteBy(1);
      } else {
        scrollBodyBy(1);
      }
      return;
    }

    if (ch === "g") {
      if (state.focusPane === "notes") {
        if (state.notes.length > 0) {
          state.selectedIndex = 0;
          const noteId = state.notes[0]?.id;
          if (noteId) {
            rememberUnfilteredSelection(noteId);
            const cached = detailsCache.get(noteId);
            if (cached) {
              applyResolvedDetails(cached);
              renderUI();
            } else {
              const token = detailLoadToken + 1;
              detailLoadToken = token;
              setPendingNoteDetails(state.notes[0] ?? null);
              renderUI();
              void loadDetails(noteId, token);
            }
          }
        }
      } else {
        const change = setBodyScroll(0);
        if (change.bodyIndexChanged) {
          renderUI();
        } else if (change.offsetChanged) {
          renderBodyViewportOnly();
        }
      }
      return;
    }

    if (ch === "G") {
      if (state.focusPane === "notes") {
        if (state.notes.length > 0) {
          state.selectedIndex = state.notes.length - 1;
          const noteId = state.notes[state.selectedIndex]?.id;
          if (noteId) {
            rememberUnfilteredSelection(noteId);
            const cached = detailsCache.get(noteId);
            if (cached) {
              applyResolvedDetails(cached);
              renderUI();
            } else {
              const token = detailLoadToken + 1;
              detailLoadToken = token;
              setPendingNoteDetails(state.notes[state.selectedIndex] ?? null);
              renderUI();
              void loadDetails(noteId, token);
            }
          }
        }
      } else {
        const change = setBodyScroll(Math.max(0, lastBodyRender.lines.length - lastBodyViewport));
        if (change.bodyIndexChanged) {
          renderUI();
        } else if (change.offsetChanged) {
          renderBodyViewportOnly();
        }
      }
      return;
    }

    if (ch === "s") {
      void runAction(async () => {
        await refresh();
      });
      return;
    }

    if (ch === "t") {
      state.theme = state.theme === "dark" ? "light" : "dark";
      setStatus(`Theme: ${state.theme}`);
      renderUI();
      return;
    }

    if (ch === "w") {
      state.wideSoftLinks = !state.wideSoftLinks;
      setStatus(`Wide soft links: ${state.wideSoftLinks ? "on" : "off"}`);
      renderUI();
      return;
    }

    if (ch === "/") {
      enterInputMode("search", "Search mode (blank clears filter)");
      return;
    }

    if (ch === "n") {
      enterInputMode("create", "Create note mode");
      return;
    }

    if (ch === "b") {
      const selected = getSelectedNote();
      if (!selected) {
        setStatus("No note selected");
        renderUI();
        return;
      }

      enterInputMode("body", `Add body to ${selected.title}`);
      return;
    }

    if (ch === "f") {
      const selected = getSelectedNote();
      if (!selected) {
        setStatus("No note selected");
        renderUI();
        return;
      }

      enterInputMode("follow", `Follow from ${selected.title}`);
      return;
    }

    if (ch === "[") {
      jumpToBodyIndex(state.details.activeBodyIndex - 1);
      return;
    }

    if (ch === "]") {
      jumpToBodyIndex(state.details.activeBodyIndex + 1);
      return;
    }

    if (ch === "e") {
      void runAction(async () => {
        await editCurrentBodyInEditor();
      });
      return;
    }

    if (ch === "l") {
      void runAction(async () => {
        await showCurrentBodyInLess();
      });
      return;
    }

    if (ch === "D") {
      const selected = getSelectedNote();
      if (!selected) {
        setStatus("No note selected");
        renderUI();
        return;
      }

      state.pendingDeleteNote = selected;
      enterInputMode("confirmDelete", `Delete ${selected.title}? This is permanent.`);
      return;
    }

    if (ch === "a") {
      const selected = getSelectedNote();
      if (!selected || selected.archivedAt) {
        return;
      }

      void runAction(async () => {
        await core.archiveNote(selected.id);
        await refresh();
        setStatus(`Archived ${selected.title}`);
        renderUI();
      });
      return;
    }

    if (ch === "r") {
      const selected = getSelectedNote();
      if (!selected || !selected.archivedAt) {
        return;
      }

      void runAction(async () => {
        await core.restoreNote(selected.id);
        await refresh(selected.id);
        setStatus(`Restored ${selected.title}`);
        renderUI();
      });
      return;
    }

    if (ch === "x") {
      void runAction(async () => {
        const next = !state.includeArchived;
        await refresh(undefined, next);
        setStatus(next ? "Showing archived notes" : "Hiding archived notes");
        renderUI();
      });
    }
  }

  function handleBodyClick(data: { x?: number; y?: number }): void {
    if (state.mode !== "none") {
      return;
    }

    const selected = getSelectedNote();
    if (!selected) {
      return;
    }

    const resolveHitForLine = (line: number, col?: number): BodyHardLinkHit | null => {
      const lineHits = lastBodyRender.hardLinkHits.filter((hit) => hit.line === line);
      if (lineHits.length === 0) {
        return null;
      }

      if (typeof col === "number") {
        const exact = lineHits.find((hit) => col >= hit.start && col < hit.end);
        if (exact) {
          return exact;
        }
      }

      if (lineHits.length === 1) {
        return lineHits[0] ?? null;
      }

      return null;
    };

    let match: BodyHardLinkHit | null = null;

    const withPos = bodyList as blessed.Widgets.ListElement & {
      selected?: number;
      lpos?: { xi: number; xl: number; yi: number; yl: number };
    };
    const lpos = withPos.lpos;
    if (lpos && typeof data.x === "number" && typeof data.y === "number") {
      const contentX = data.x - lpos.xi - 1;
      const contentY = data.y - lpos.yi - 1;
      const contentWidth = Math.max(0, lpos.xl - lpos.xi - 1);
      const contentHeight = Math.max(0, lpos.yl - lpos.yi - 1);
      if (contentX >= 0 && contentY >= 0 && contentX < contentWidth && contentY < contentHeight) {
        const line = state.bodyScrollOffset + contentY;
        match = resolveHitForLine(line, contentX);
      }
    }

    if (!match && typeof withPos.selected === "number") {
      match = resolveHitForLine(bodyWindowStart + withPos.selected);
    }

    if (!match) {
      return;
    }

    state.focusPane = "bodies";
    void runAction(async () => {
      await followAndShow(selected.id, match.target);
      renderUI();
    });
  }

  screen.on("keypress", (ch, key) => {
    const input = ch ?? "";

    if (key.ctrl && key.name === "c") {
      screen.destroy();
      process.exit(0);
      return;
    }

    if (state.mode !== "none") {
      handleInputMode(input, key);
      return;
    }

    handleMainKey(input, key);
  });

  bodyList.on("click", (data: unknown) => {
    handleBodyClick(data as { x?: number; y?: number });
  });

  (bodyList as blessed.Widgets.ListElement & { on(event: string, listener: (...args: unknown[]) => void): void }).on(
    "element click",
    (_item: unknown, data: unknown) => {
      handleBodyClick(data as { x?: number; y?: number });
    }
  );

  screen.on("resize", () => {
    renderUI();
  });

  void (async () => {
    try {
      await core.init();
      await refresh();
      renderUI();
    } catch (error) {
      screen.destroy();
      process.stderr.write(`mimex tui failed: ${(error as Error).message}\n`);
      process.exit(1);
    }
  })();
}

main();
