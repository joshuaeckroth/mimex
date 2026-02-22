#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { MimexCore } from "@mimex/core";
import type { FollowLinkResult, NoteMeta, SearchResult } from "@mimex/shared-types";
import { normalizeKey, parseLimit, readStdinText, resolveMarkdownInput } from "./input.js";
import { renderCompletionScript, SUPPORTED_SHELLS } from "./completion.js";
import { importFromNotionMcp } from "./importers/notion.js";
import {
  porcelainFollowResult,
  porcelainHardLinks,
  porcelainLinkResolutions,
  porcelainNoteDeleted,
  porcelainNote,
  porcelainNotesList,
  porcelainSearch,
  porcelainSoftLinks,
  renderFollowResult,
  renderHardLinks,
  renderLinkResolutions,
  renderNote,
  renderNotesList,
  renderSearch,
  renderSoftLinks,
  type LinkResolution
} from "./output.js";

const defaultWorkspace = process.env.MIMEX_WORKSPACE_PATH ?? path.resolve(process.cwd(), "data/workspaces/local");

type OutputMode = "human" | "json" | "porcelain";

interface GlobalOptions {
  workspace: string;
  json?: boolean;
  porcelain?: boolean;
}

interface ImportNotionOptions {
  query?: string;
  limit: string;
  dryRun?: boolean;
  mcpCommand: string;
  mcpArg?: string[];
  strategy: "heuristic" | "llm";
  plannerCommand?: string;
  plannerTimeoutMs: string;
}

function createCore(workspace: string): MimexCore {
  return new MimexCore(workspace);
}

function getGlobals(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function resolveOutputMode(globals: GlobalOptions): OutputMode {
  if (globals.json && globals.porcelain) {
    throw new Error("--json and --porcelain are mutually exclusive");
  }

  if (globals.porcelain) {
    return "porcelain";
  }

  if (globals.json) {
    return "json";
  }

  return "human";
}

function printOutput(value: unknown, human: string, porcelain: string): void {
  const mode = resolveOutputMode(getGlobals());
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (mode === "porcelain") {
    if (porcelain) {
      process.stdout.write(`${porcelain}\n`);
    }
    return;
  }

  if (human) {
    process.stdout.write(`${human}\n`);
  }
}

async function withCore<T>(fn: (core: MimexCore, workspace: string) => Promise<T>): Promise<T> {
  const { workspace } = getGlobals();
  const core = createCore(workspace);
  await core.init();
  return fn(core, workspace);
}

function findExactTarget(linkRaw: string, notes: NoteMeta[]): NoteMeta | null {
  const wanted = normalizeKey(linkRaw);
  for (const note of notes) {
    if (normalizeKey(note.title) === wanted) {
      return note;
    }
    if (note.aliases.some((alias) => normalizeKey(alias) === wanted)) {
      return note;
    }
  }
  return null;
}

async function resolveLinks(core: MimexCore, noteRef: string, limit: number): Promise<LinkResolution[]> {
  const links = await core.parseHardLinks(noteRef);
  const notes = await core.listNotes();
  const rows: LinkResolution[] = [];

  for (const link of links) {
    const exact = findExactTarget(link.raw, notes);
    if (exact) {
      rows.push({
        link: link.raw,
        resolution: "hard",
        targetNoteId: exact.id,
        targetTitle: exact.title,
        candidates: []
      });
      continue;
    }

    const candidates = await core.searchNotes(link.raw, limit);
    if (candidates.length === 0) {
      rows.push({
        link: link.raw,
        resolution: "none",
        targetNoteId: null,
        targetTitle: null,
        candidates
      });
      continue;
    }

    rows.push({
      link: link.raw,
      resolution: "search",
      targetNoteId: candidates[0]?.noteId ?? null,
      targetTitle: candidates[0]?.title ?? null,
      candidates
    });
  }

  return rows;
}

const program = new Command();
program
  .name("mimex-cli")
  .description("Mimex CLI")
  .option("-w, --workspace <path>", "workspace directory", defaultWorkspace)
  .option("--json", "emit JSON output")
  .option("--porcelain", "emit stable tab-delimited output for scripts");

program
  .command("workspace:info")
  .description("show workspace summary")
  .action(async () => {
    await withCore(async (core, workspace) => {
      const notes = await core.listNotes({ includeArchived: true });
      const activeNotes = notes.filter((note) => !note.archivedAt);
      const archivedNotes = notes.length - activeNotes.length;
      const bodyCount = notes.reduce((acc, note) => acc + note.bodies.length, 0);

      let softEventCount = 0;
      try {
        const raw = await readFile(path.join(workspace, ".mimex", "softlinks.json"), "utf8");
        const parsed = JSON.parse(raw) as { events?: unknown[] };
        softEventCount = parsed.events?.length ?? 0;
      } catch {
        softEventCount = 0;
      }

      const payload = {
        workspace,
        notes: activeNotes.length,
        archivedNotes,
        totalNotes: notes.length,
        bodies: bodyCount,
        softLinkEvents: softEventCount
      };

      const porcelain = [
        "WORKSPACE",
        workspace,
        activeNotes.length,
        archivedNotes,
        notes.length,
        bodyCount,
        softEventCount
      ].join("\t");
      const human = [
        `Workspace: ${workspace}`,
        `Notes: ${activeNotes.length} active / ${archivedNotes} archived`,
        `Bodies: ${bodyCount}`,
        `Soft-link events: ${softEventCount}`
      ].join("\n");

      printOutput(payload, human, porcelain);
    });
  });

program
  .command("note:create")
  .description("create a note and optionally the first body")
  .argument("<title>", "note title")
  .argument("[markdown]", "body markdown text; pass '-' to read stdin")
  .option("-m, --markdown <markdown>", "initial markdown body")
  .option("-f, --markdown-file <path>", "read markdown from file")
  .option("-l, --label <label>", "body label")
  .option("-a, --alias <alias...>", "aliases for title")
  .action(async (title, markdownArg, options) => {
    await withCore(async (core) => {
      const markdown = await resolveMarkdownInput({
        positional: markdownArg,
        markdownOption: options.markdown,
        markdownFile: options.markdownFile,
        stdinIsTTY: process.stdin.isTTY,
        readStdin: readStdinText
      });

      const note = await core.createNote({
        title,
        markdown,
        label: options.label,
        aliases: options.alias
      });

      printOutput(note, renderNote(note), porcelainNote(note));
    });
  });

program
  .command("note:get")
  .description("fetch a note")
  .argument("<noteRef>", "note id or title")
  .action(async (noteRef) => {
    await withCore(async (core) => {
      const note = await core.getNote(noteRef);
      printOutput(note, renderNote(note), porcelainNote(note));
    });
  });

program
  .command("note:list")
  .description("list notes")
  .option("--all", "include archived notes")
  .action(async (options) => {
    await withCore(async (core) => {
      const notes = await core.listNotes({ includeArchived: Boolean(options.all) });
      printOutput(notes, renderNotesList(notes), porcelainNotesList(notes));
    });
  });

program
  .command("note:archive")
  .description("archive a note (non-destructive alternative to delete)")
  .argument("<noteRef>", "note id or title")
  .action(async (noteRef) => {
    await withCore(async (core) => {
      const note = await core.archiveNote(noteRef);
      printOutput(note, renderNote(note), porcelainNote(note));
    });
  });

program
  .command("note:restore")
  .description("restore an archived note")
  .argument("<noteRef>", "note id or title")
  .action(async (noteRef) => {
    await withCore(async (core) => {
      const note = await core.restoreNote(noteRef);
      printOutput(note, renderNote(note), porcelainNote(note));
    });
  });

program
  .command("note:delete")
  .description("delete a note permanently")
  .argument("<noteRef>", "note id or title")
  .action(async (noteRef) => {
    await withCore(async (core) => {
      const deleted = await core.deleteNote(noteRef);
      const human = `Deleted ${deleted.title} (${deleted.id})`;
      const porcelain = porcelainNoteDeleted(deleted);
      printOutput(deleted, human, porcelain);
    });
  });

program
  .command("body:add")
  .description("add a body to a note")
  .argument("<noteRef>", "note id or title")
  .argument("[markdown]", "body markdown text; pass '-' to read stdin")
  .option("-m, --markdown <markdown>", "body markdown")
  .option("-f, --markdown-file <path>", "read markdown from file")
  .option("-l, --label <label>", "body label")
  .action(async (noteRef, markdownArg, options) => {
    await withCore(async (core) => {
      const markdown = await resolveMarkdownInput({
        positional: markdownArg,
        markdownOption: options.markdown,
        markdownFile: options.markdownFile,
        stdinIsTTY: process.stdin.isTTY,
        readStdin: readStdinText
      });

      if (!markdown) {
        throw new Error("body markdown is required (arg, --markdown, --markdown-file, or stdin)");
      }

      const note = await core.addBody({ noteRef, markdown, label: options.label });
      printOutput(note, renderNote(note), porcelainNote(note));
    });
  });

program
  .command("search")
  .description("search note titles and bodies")
  .argument("<query>", "search query")
  .option("-l, --limit <number>", "result limit", "10")
  .option("--all", "include archived notes")
  .action(async (query, options) => {
    await withCore(async (core) => {
      const limit = parseLimit(options.limit, 10);
      const results = await core.searchNotes(query, limit, { includeArchived: Boolean(options.all) });
      printOutput(results, renderSearch(results), porcelainSearch(results));
    });
  });

program
  .command("follow")
  .description("follow a link from source note")
  .argument("<source>", "source note")
  .argument("<target>", "hard link target text")
  .action(async (source, target) => {
    await withCore(async (core) => {
      const result = await core.followLink(source, target);
      printOutput(result, renderFollowResult(result), porcelainFollowResult(result));
    });
  });

program
  .command("import:notion")
  .description("import notes from Notion via MCP")
  .option("-q, --query <query>", "search query to find pages in Notion (omit to fetch all accessible pages)")
  .option("-l, --limit <number>", "max fetched references", "25")
  .option("--dry-run", "plan import without writing notes")
  .option("--mcp-command <command>", "MCP bridge command", "npx")
  .option(
    "--mcp-arg <arg...>",
    "MCP bridge args (default: -y mcp-remote https://mcp.notion.com/mcp)",
    ["-y", "mcp-remote", "https://mcp.notion.com/mcp"]
  )
  .option("--strategy <strategy>", "note planning strategy: heuristic|llm", "heuristic")
  .option("--planner-command <command>", "shell command for LLM-based planner (reads JSON stdin, writes JSON stdout)")
  .option("--planner-timeout-ms <ms>", "LLM planner timeout in ms", "60000")
  .action(async (options: ImportNotionOptions) => {
    const outputMode = resolveOutputMode(getGlobals());
    const emitImportStatus =
      outputMode === "human"
        ? (message: string): void => {
            process.stderr.write(`[notion-import] ${message}\n`);
          }
        : undefined;

    await withCore(async (core) => {
      const strategy = options.strategy === "llm" ? "llm" : "heuristic";
      const summary = await importFromNotionMcp(core, {
        query: options.query?.trim(),
        limit: parseLimit(options.limit, 25),
        dryRun: Boolean(options.dryRun),
        mcpCommand: options.mcpCommand,
        mcpArgs: options.mcpArg && options.mcpArg.length > 0 ? options.mcpArg : ["-y", "mcp-remote", "https://mcp.notion.com/mcp"],
        strategy,
        plannerCommand: options.plannerCommand,
        plannerTimeoutMs: parseLimit(options.plannerTimeoutMs, 60000),
        onStatus: emitImportStatus
      });

      const humanLines = [
        `Notion import (${summary.strategy}) query="${summary.query || "(all pages)"}"`,
        `References discovered: ${summary.referencesDiscovered}`,
        `Fetched documents: ${summary.fetchedDocuments}`,
        `Planned notes: ${summary.plannedNotes}`,
        `Created notes: ${summary.createdNotes}`,
        `Added bodies: ${summary.addedBodies}`,
        `Skipped duplicate bodies: ${summary.skippedBodies}`
      ];

      if (summary.notes.length > 0) {
        humanLines.push("Notes:");
        for (const note of summary.notes) {
          humanLines.push(`- ${note.title} | bodies=${note.bodyLabels.length} | refs=${note.sourceRefs.length}`);
        }
      }

      if (summary.errors.length > 0) {
        humanLines.push("Errors:");
        for (const error of summary.errors) {
          humanLines.push(`- ${error}`);
        }
      }

      const porcelainLines = [
        [
          "IMPORT",
          "notion",
          summary.strategy,
          summary.query,
          summary.referencesDiscovered,
          summary.fetchedDocuments,
          summary.plannedNotes,
          summary.createdNotes,
          summary.addedBodies,
          summary.skippedBodies
        ].join("\t")
      ];
      for (const note of summary.notes) {
        porcelainLines.push(["IMPORT_NOTE", note.title, note.bodyLabels.length, note.sourceRefs.length].join("\t"));
      }
      for (const error of summary.errors) {
        porcelainLines.push(["IMPORT_ERROR", error.replace(/[\t\n\r]+/g, " ").trim()].join("\t"));
      }

      printOutput(summary, humanLines.join("\n"), porcelainLines.join("\n"));
    });
  });

program
  .command("completion")
  .description("print shell completion script")
  .argument("<shell>", `shell (${SUPPORTED_SHELLS.join(", ")})`)
  .action((shell) => {
    const script = renderCompletionScript(shell);
    process.stdout.write(script);
  });

program
  .command("links:hard")
  .description("show parsed hard links from a note")
  .argument("<noteRef>", "note id or title")
  .action(async (noteRef) => {
    await withCore(async (core) => {
      const links = await core.parseHardLinks(noteRef);
      printOutput(links, renderHardLinks(links), porcelainHardLinks(links));
    });
  });

program
  .command("links:resolve")
  .description("resolve each hard link without mutating soft-link weights")
  .argument("<noteRef>", "note id or title")
  .option("-l, --limit <number>", "search candidates per unresolved link", "3")
  .action(async (noteRef, options) => {
    await withCore(async (core) => {
      const limit = parseLimit(options.limit, 3);
      const rows = await resolveLinks(core, noteRef, limit);
      printOutput(rows, renderLinkResolutions(rows), porcelainLinkResolutions(rows));
    });
  });

program
  .command("links:follow-hard")
  .description("follow all hard links from a source note and update soft-link weights")
  .argument("<noteRef>", "source note")
  .option("-l, --limit <number>", "max hard links to follow", "100")
  .action(async (noteRef, options) => {
    await withCore(async (core) => {
      const limit = parseLimit(options.limit, 100);
      const links = await core.parseHardLinks(noteRef);
      const selected = links.slice(0, limit);
      const results: FollowLinkResult[] = [];
      for (const link of selected) {
        results.push(await core.followLink(noteRef, link.raw));
      }

      const human = results.map(renderFollowResult).join("\n---\n");
      const porcelain = results.map((result) => porcelainFollowResult(result)).join("\n");
      printOutput(results, human, porcelain);
    });
  });

program
  .command("links:soft")
  .description("show top soft links for a note")
  .argument("<noteRef>", "note id or title")
  .option("-l, --limit <number>", "result limit", "10")
  .action(async (noteRef, options) => {
    await withCore(async (core) => {
      const links = await core.getTopSoftLinks(noteRef, parseLimit(options.limit, 10));
      printOutput(links, renderSoftLinks(links), porcelainSoftLinks(links));
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
