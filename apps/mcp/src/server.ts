#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MimexCore } from "@mimex/core";
import { z } from "zod";

const workspaceRoot = process.env.MIMEX_WORKSPACE_ROOT ?? path.resolve(process.cwd(), "data/workspaces");
const defaultUserId = process.env.MIMEX_DEFAULT_USER_ID ?? "local";
const autoCommit = parseEnvBool(process.env.MIMEX_AUTO_COMMIT, true);

const coreByUser = new Map<string, MimexCore>();

export function parseEnvBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function normalizeUserId(value: string | undefined): string {
  const cleaned = (value ?? defaultUserId).trim();
  if (!cleaned) {
    return "local";
  }
  const safe = cleaned.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return safe || "local";
}

interface CoreContext {
  userId: string;
  workspacePath: string;
  core: MimexCore;
}

async function getCoreContext(userIdRaw: string | undefined): Promise<CoreContext> {
  const userId = normalizeUserId(userIdRaw);
  const existing = coreByUser.get(userId);
  if (existing) {
    return {
      userId,
      workspacePath: path.join(workspaceRoot, userId),
      core: existing
    };
  }

  const workspacePath = path.join(workspaceRoot, userId);
  await mkdir(workspacePath, { recursive: true });
  const core = new MimexCore(workspacePath, { autoCommit });
  await core.init();
  coreByUser.set(userId, core);
  return { userId, workspacePath, core };
}

function resultJson(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function resultError(error: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}

export async function workspaceInfo(userIdRaw: string | undefined): Promise<{
  userId: string;
  workspace: string;
  notes: number;
  archivedNotes: number;
  totalNotes: number;
  bodies: number;
  softLinkEvents: number;
}> {
  const { userId, workspacePath, core } = await getCoreContext(userIdRaw);
  const notes = await core.listNotes({ includeArchived: true });
  const activeNotes = notes.filter((note) => !note.archivedAt);
  const archivedNotes = notes.length - activeNotes.length;
  const bodyCount = notes.reduce((acc, note) => acc + note.bodies.length, 0);

  let softEventCount = 0;
  try {
    const raw = await readFile(path.join(workspacePath, ".mimex", "softlinks.json"), "utf8");
    const parsed = JSON.parse(raw) as { events?: unknown[] };
    softEventCount = parsed.events?.length ?? 0;
  } catch {
    softEventCount = 0;
  }

  return {
    userId,
    workspace: workspacePath,
    notes: activeNotes.length,
    archivedNotes,
    totalNotes: notes.length,
    bodies: bodyCount,
    softLinkEvents: softEventCount
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "mimex_workspace_info",
    {
      title: "Mimex Workspace Info",
      description: "Get workspace-level counts for notes, bodies, and soft-link events.",
      inputSchema: {
        userId: z.string().optional().describe("Workspace user id. Defaults to MIMEX_DEFAULT_USER_ID/local.")
      }
    },
    async ({ userId }) => {
      try {
        return resultJson(await workspaceInfo(userId));
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_note_list",
    {
      title: "Mimex List Notes",
      description: "List notes for a Mimex workspace.",
      inputSchema: {
        userId: z.string().optional(),
        includeArchived: z.boolean().optional().default(false),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().positive().max(500).optional().default(200)
      }
    },
    async ({ userId, includeArchived, offset, limit }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const all = await core.listNotes({ includeArchived });
        const notes = all.slice(offset, offset + limit);
        const nextOffset = offset + notes.length < all.length ? offset + notes.length : null;
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          total: all.length,
          offset,
          limit,
          nextOffset,
          count: notes.length,
          notes
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_note_titles",
    {
      title: "Mimex Note Titles",
      description: "List note ids and titles only (lightweight, paged).",
      inputSchema: {
        userId: z.string().optional(),
        includeArchived: z.boolean().optional().default(false),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().positive().max(1000).optional().default(500)
      }
    },
    async ({ userId, includeArchived, offset, limit }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const all = await core.listNotes({ includeArchived });
        const page = all.slice(offset, offset + limit).map((note) => ({
          id: note.id,
          title: note.title,
          archivedAt: note.archivedAt,
          bodyCount: note.bodies.length,
          updatedAt: note.updatedAt
        }));
        const nextOffset = offset + page.length < all.length ? offset + page.length : null;

        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          total: all.length,
          offset,
          limit,
          nextOffset,
          count: page.length,
          notes: page
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_note_get",
    {
      title: "Mimex Get Note",
      description: "Get a note with all markdown bodies by note id/title/alias reference.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1).describe("Note id, title, or alias.")
      }
    },
    async ({ userId, noteRef }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.getNote(noteRef);
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_note_create",
    {
      title: "Mimex Create Note",
      description:
        "Create a note (or return existing note by title). If markdown is supplied and note exists, it appends a new body.",
      inputSchema: {
        userId: z.string().optional(),
        title: z.string().min(1),
        aliases: z.array(z.string().min(1)).optional(),
        markdown: z.string().optional(),
        label: z.string().optional()
      }
    },
    async ({ userId, title, aliases, markdown, label }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.createNote({ title, aliases, markdown, label });
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_body_add",
    {
      title: "Mimex Add Body",
      description: "Add a markdown body to an existing note.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1),
        markdown: z.string().min(1),
        label: z.string().optional()
      }
    },
    async ({ userId, noteRef, markdown, label }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.addBody({ noteRef, markdown, label });
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_body_update",
    {
      title: "Mimex Update Body",
      description: "Replace markdown for an existing note body.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1),
        bodyId: z.string().min(1),
        markdown: z.string()
      }
    },
    async ({ userId, noteRef, bodyId, markdown }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.updateBody({ noteRef, bodyId, markdown });
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_body_rename",
    {
      title: "Mimex Rename Body",
      description: "Rename the label for an existing note body.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1),
        bodyId: z.string().min(1),
        label: z.string().min(1)
      }
    },
    async ({ userId, noteRef, bodyId, label }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.renameBody({ noteRef, bodyId, label });
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_body_delete",
    {
      title: "Mimex Delete Body",
      description: "Delete an existing note body.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1),
        bodyId: z.string().min(1)
      }
    },
    async ({ userId, noteRef, bodyId }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.deleteBody({ noteRef, bodyId });
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_note_archive",
    {
      title: "Mimex Archive Note",
      description: "Archive a note without deleting it.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1)
      }
    },
    async ({ userId, noteRef }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.archiveNote(noteRef);
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_note_restore",
    {
      title: "Mimex Restore Note",
      description: "Restore an archived note.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1)
      }
    },
    async ({ userId, noteRef }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const note = await core.restoreNote(noteRef);
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          note
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_search_notes",
    {
      title: "Mimex Search Notes",
      description: "Search notes and bodies.",
      inputSchema: {
        userId: z.string().optional(),
        query: z.string().min(1),
        limit: z.number().int().positive().max(200).optional().default(10),
        includeArchived: z.boolean().optional().default(false)
      }
    },
    async ({ userId, query, limit, includeArchived }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const results = await core.searchNotes(query, limit, { includeArchived });
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          count: results.length,
          results
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_links_hard",
    {
      title: "Mimex Hard Links",
      description: "Parse hard links from a note's bodies.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1)
      }
    },
    async ({ userId, noteRef }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const links = await core.parseHardLinks(noteRef);
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          count: links.length,
          links
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_follow_link",
    {
      title: "Mimex Follow Link",
      description: "Follow a target from a source note and update soft-link weights.",
      inputSchema: {
        userId: z.string().optional(),
        source: z.string().min(1),
        target: z.string().min(1)
      }
    },
    async ({ userId, source, target }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const result = await core.followLink(source, target);
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          result
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );

  server.registerTool(
    "mimex_links_soft",
    {
      title: "Mimex Soft Links",
      description: "Get top weighted soft links for a note.",
      inputSchema: {
        userId: z.string().optional(),
        noteRef: z.string().min(1),
        limit: z.number().int().positive().max(50).optional().default(10)
      }
    },
    async ({ userId, noteRef, limit }) => {
      try {
        const { userId: resolvedUserId, workspacePath, core } = await getCoreContext(userId);
        const links = await core.getTopSoftLinks(noteRef, limit);
        return resultJson({
          userId: resolvedUserId,
          workspace: workspacePath,
          count: links.length,
          links
        });
      } catch (error) {
        return resultError(error);
      }
    }
  );
}

export async function startMcpServer(): Promise<void> {
  // Keep process alive for stdio mode in non-interactive shells where stdin may report EOF immediately.
  const keepAlive = setInterval(() => {}, 60_000);
  process.on("exit", () => clearInterval(keepAlive));
  process.stdin.resume();

  const server = new McpServer(
    {
      name: "mimex-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`mimex-mcp ready (workspaceRoot=${workspaceRoot}, autoCommit=${String(autoCommit)})`);
}

const isVitest = process.env.VITEST === "true";
if (!isVitest) {
  startMcpServer().catch((error) => {
    console.error("mimex-mcp failed:", error);
    process.exit(1);
  });
}
