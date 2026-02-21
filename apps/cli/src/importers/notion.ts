import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MimexCore } from "@mimex/core";
import { normalizeKey } from "../input.js";

export interface NotionImportBody {
  label: string;
  markdown: string;
}

export interface NotionImportNotePlan {
  title: string;
  aliases: string[];
  bodies: NotionImportBody[];
  sourceRefs: string[];
}

export interface NotionImportDraft {
  title: string;
  markdown: string;
  sourceRef: string;
  sourceUrl: string | null;
}

export interface NotionImportOptions {
  query: string;
  limit: number;
  dryRun: boolean;
  mcpCommand: string;
  mcpArgs: string[];
  strategy: "heuristic" | "llm";
  plannerCommand?: string;
  plannerTimeoutMs: number;
}

export interface NotionImportSummary {
  strategy: "heuristic" | "llm";
  query: string;
  referencesDiscovered: number;
  fetchedDocuments: number;
  plannedNotes: number;
  createdNotes: number;
  addedBodies: number;
  skippedBodies: number;
  errors: string[];
  notes: Array<{
    title: string;
    aliases: string[];
    bodyLabels: string[];
    sourceRefs: string[];
  }>;
}

type JsonObject = Record<string, unknown>;
type McpTool = {
  name: string;
  inputSchema?: unknown;
};
type McpCallResult = {
  content?: unknown;
  structuredContent?: unknown;
};

const NOTION_URL_RE = /https?:\/\/(?:www\.)?notion\.so\/[^\s<>"')\]]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const HEX32_RE = /\b[0-9a-f]{32}\b/gi;

function asRecord(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

function allStrings(value: unknown): string[] {
  const out: string[] = [];

  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
      }
      return;
    }

    const rec = asRecord(node);
    if (!rec) {
      return;
    }

    for (const entry of Object.values(rec)) {
      walk(entry);
    }
  };

  walk(value);
  return out;
}

function extractByRegex(text: string, pattern: RegExp): string[] {
  const values = text.match(pattern);
  return values ? values : [];
}

function dedupeRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs.map((item) => item.trim()).filter(Boolean)) {
    const key = ref.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function extractTitleFromMarkdown(markdown: string): string | null {
  const heading = markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }
  return null;
}

function cleanTitle(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact) {
    return compact.slice(0, 220);
  }
  return "Untitled Notion Import";
}

function formatSourceBlock(sourceRef: string, sourceUrl: string | null): string {
  const ts = new Date().toISOString();
  const lines = [
    `> Imported from Notion via MCP at ${ts}`,
    `> Source reference: ${sourceRef}`
  ];
  if (sourceUrl) {
    lines.push(`> Source URL: ${sourceUrl}`);
  }
  return `${lines.join("\n")}\n\n`;
}

function toolInputProperties(tool: McpTool): string[] {
  const schema = asRecord(tool.inputSchema);
  const props = asRecord(schema?.properties);
  if (!props) {
    return [];
  }
  return Object.keys(props);
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function guessTitleFromFetch(result: McpCallResult, fallbackRef: string): string {
  const structured = asRecord(result.structuredContent);
  const titleCandidateKeys = ["title", "name", "page_title", "display_title"];
  if (structured) {
    for (const key of titleCandidateKeys) {
      const value = maybeString(structured[key]);
      if (value) {
        return cleanTitle(value);
      }
    }
  }

  const text = extractTextBlocks(result).join("\n\n");
  const heading = extractTitleFromMarkdown(text);
  if (heading) {
    return cleanTitle(heading);
  }

  if (isLikelyUrl(fallbackRef)) {
    try {
      const url = new URL(fallbackRef);
      const tail = url.pathname.split("/").filter(Boolean).at(-1);
      if (tail) {
        return cleanTitle(tail.replace(/[-_]/g, " "));
      }
    } catch {
      // ignore
    }
  }

  return cleanTitle(fallbackRef);
}

function extractTextBlocks(result: McpCallResult): string[] {
  const blocks: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];

  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) {
      continue;
    }

    if (rec.type === "text" && typeof rec.text === "string") {
      blocks.push(rec.text);
    }
  }

  if (blocks.length > 0) {
    return blocks;
  }

  if (result.structuredContent !== undefined) {
    return [JSON.stringify(result.structuredContent, null, 2)];
  }

  return [];
}

function summarizePlan(plan: NotionImportNotePlan[]): NotionImportSummary["notes"] {
  return plan.map((note) => ({
    title: note.title,
    aliases: note.aliases,
    bodyLabels: note.bodies.map((body) => body.label),
    sourceRefs: note.sourceRefs
  }));
}

function bodyHash(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function chooseTool(tools: McpTool[], preferred: string[], fallbackContains: string): McpTool {
  for (const name of preferred) {
    const found = tools.find((tool) => tool.name === name);
    if (found) {
      return found;
    }
  }

  const contains = tools.find((tool) => tool.name.includes(fallbackContains));
  if (contains) {
    return contains;
  }

  throw new Error(`required MCP tool not found: ${preferred.join(" or ")}`);
}

function buildSearchArgs(tool: McpTool, query: string): JsonObject {
  const properties = new Set(toolInputProperties(tool));
  const args: JsonObject = {};

  if (properties.has("query")) {
    args.query = query;
  } else if (properties.has("q")) {
    args.q = query;
  } else {
    const first = [...properties][0];
    if (first) {
      args[first] = query;
    }
  }

  if (properties.has("query_type")) {
    args.query_type = "internal";
  }

  return args;
}

function buildFetchArgs(tool: McpTool, ref: string): JsonObject {
  const properties = new Set(toolInputProperties(tool));
  const args: JsonObject = {};
  const urlLike = isLikelyUrl(ref);

  const urlKeys = ["url", "page_url", "target_url", "resource_url"];
  const idKeys = ["id", "page_id", "database_id", "target_id"];

  if (urlLike) {
    const urlKey = urlKeys.find((key) => properties.has(key));
    if (urlKey) {
      args[urlKey] = ref;
      return args;
    }
  }

  const idKey = idKeys.find((key) => properties.has(key));
  if (idKey) {
    args[idKey] = ref;
    return args;
  }

  const urlKey = urlKeys.find((key) => properties.has(key));
  if (urlKey) {
    args[urlKey] = ref;
    return args;
  }

  args.id = ref;
  return args;
}

function parsePlannerOutput(raw: string): NotionImportNotePlan[] {
  const parsed = JSON.parse(raw) as { notes?: unknown };
  const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
  const out: NotionImportNotePlan[] = [];

  for (const item of notes) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    const title = maybeString(rec.title);
    if (!title) {
      continue;
    }

    const aliases = Array.isArray(rec.aliases) ? rec.aliases.map(maybeString).filter((v): v is string => Boolean(v)) : [];
    const bodiesRaw = Array.isArray(rec.bodies) ? rec.bodies : [];
    const bodies: NotionImportBody[] = [];

    for (const bodyEntry of bodiesRaw) {
      const bodyRec = asRecord(bodyEntry);
      if (!bodyRec) {
        continue;
      }
      const markdown = maybeString(bodyRec.markdown);
      if (!markdown) {
        continue;
      }
      const label = maybeString(bodyRec.label) ?? "imported";
      bodies.push({ label, markdown });
    }

    if (bodies.length === 0) {
      continue;
    }

    const sourceRefs =
      Array.isArray(rec.sourceRefs)
        ? rec.sourceRefs.map(maybeString).filter((v): v is string => Boolean(v))
        : [];

    out.push({
      title: cleanTitle(title),
      aliases: aliases.map(cleanTitle),
      bodies,
      sourceRefs: dedupeRefs(sourceRefs)
    });
  }

  return out;
}

async function runPlannerCommand(command: string, drafts: NotionImportDraft[], timeoutMs: number): Promise<NotionImportNotePlan[]> {
  const payload = JSON.stringify(
    {
      task: "Split Notion import drafts into Mimex notes and bodies. Output strict JSON: {\"notes\": [...]}",
      schema: {
        notes: [
          {
            title: "string",
            aliases: ["string"],
            bodies: [{ label: "string", markdown: "string" }],
            sourceRefs: ["string"]
          }
        ]
      },
      drafts
    },
    null,
    2
  );

  return new Promise<NotionImportNotePlan[]>((resolve, reject) => {
    const child = spawn("sh", ["-lc", command], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`planner command timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`planner command failed with code ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }

      try {
        const parsed = parsePlannerOutput(Buffer.concat(stdout).toString("utf8"));
        if (parsed.length === 0) {
          reject(new Error("planner output produced zero notes"));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`planner output parse error: ${(error as Error).message}`));
      }
    });

    child.stdin.write(payload, "utf8");
    child.stdin.end();
  });
}

export function extractNotionReferencesFromToolResult(result: unknown): string[] {
  const refs: string[] = [];
  for (const text of allStrings(result)) {
    refs.push(...extractByRegex(text, NOTION_URL_RE));
    refs.push(...extractByRegex(text, UUID_RE));
    refs.push(...extractByRegex(text, HEX32_RE));
  }
  return dedupeRefs(refs);
}

export function planNotesHeuristic(drafts: NotionImportDraft[]): NotionImportNotePlan[] {
  const grouped = new Map<string, NotionImportNotePlan>();
  const today = new Date().toISOString().slice(0, 10);

  for (const draft of drafts) {
    const title = cleanTitle(draft.title);
    const key = normalizeKey(title);
    const block = formatSourceBlock(draft.sourceRef, draft.sourceUrl);
    const body: NotionImportBody = {
      label: `notion-import-${today}`,
      markdown: `${block}${draft.markdown.trim()}`.trim()
    };

    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        title,
        aliases: [],
        bodies: [body],
        sourceRefs: [draft.sourceRef]
      });
      continue;
    }

    existing.bodies.push(body);
    existing.sourceRefs.push(draft.sourceRef);
  }

  return [...grouped.values()].map((note) => ({
    ...note,
    sourceRefs: dedupeRefs(note.sourceRefs)
  }));
}

async function ensureConnectedClient(command: string, args: string[]): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const client = new Client({
    name: "mimex-cli-notion-importer",
    version: "0.1.0"
  });

  const transport = new StdioClientTransport({
    command,
    args
  });

  await client.connect(transport);

  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
      try {
        await transport.close();
      } catch {
        // ignore close errors
      }
    }
  };
}

export async function importFromNotionMcp(core: MimexCore, options: NotionImportOptions): Promise<NotionImportSummary> {
  const summary: NotionImportSummary = {
    strategy: options.strategy,
    query: options.query,
    referencesDiscovered: 0,
    fetchedDocuments: 0,
    plannedNotes: 0,
    createdNotes: 0,
    addedBodies: 0,
    skippedBodies: 0,
    errors: [],
    notes: []
  };

  const { client, close } = await ensureConnectedClient(options.mcpCommand, options.mcpArgs);
  try {
    const listed = (await client.listTools()) as { tools?: McpTool[] };
    const tools = listed.tools ?? [];
    const searchTool = chooseTool(tools, ["notion-search", "search"], "search");
    const fetchTool = chooseTool(tools, ["notion-fetch", "fetch"], "fetch");

    const searchArgs = buildSearchArgs(searchTool, options.query);
    const searchResult = (await client.callTool({
      name: searchTool.name,
      arguments: searchArgs
    })) as McpCallResult;

    const refs = extractNotionReferencesFromToolResult(searchResult).slice(0, options.limit);
    summary.referencesDiscovered = refs.length;

    const drafts: NotionImportDraft[] = [];

    for (const ref of refs) {
      try {
        const fetchResult = (await client.callTool({
          name: fetchTool.name,
          arguments: buildFetchArgs(fetchTool, ref)
        })) as McpCallResult;

        const textBlocks = extractTextBlocks(fetchResult);
        const markdown = textBlocks.join("\n\n").trim();
        if (!markdown) {
          summary.errors.push(`empty fetch content for ${ref}`);
          continue;
        }

        const discoveredRefs = extractNotionReferencesFromToolResult(fetchResult);
        const sourceUrl = discoveredRefs.find(isLikelyUrl) ?? (isLikelyUrl(ref) ? ref : null);
        drafts.push({
          title: guessTitleFromFetch(fetchResult, sourceUrl ?? ref),
          markdown,
          sourceRef: ref,
          sourceUrl
        });
      } catch (error) {
        summary.errors.push(`fetch failed for ${ref}: ${(error as Error).message}`);
      }
    }

    summary.fetchedDocuments = drafts.length;

    let plan = planNotesHeuristic(drafts);
    if (options.strategy === "llm") {
      if (!options.plannerCommand) {
        throw new Error("strategy=llm requires --planner-command");
      }
      plan = await runPlannerCommand(options.plannerCommand, drafts, options.plannerTimeoutMs);
    }

    summary.plannedNotes = plan.length;
    summary.notes = summarizePlan(plan);

    if (options.dryRun) {
      return summary;
    }

    const beforeTitles = new Set(
      (await core.listNotes({ includeArchived: true })).map((note) => normalizeKey(note.title))
    );

    for (const planned of plan) {
      const created = !beforeTitles.has(normalizeKey(planned.title));
      const note = await core.createNote({
        title: planned.title,
        aliases: planned.aliases
      });

      if (created) {
        summary.createdNotes += 1;
        beforeTitles.add(normalizeKey(note.note.title));
      }

      const existing = await core.getNote(note.note.id);
      const existingHashes = new Set(existing.bodies.map((body) => bodyHash(body.markdown)));

      for (const body of planned.bodies) {
        const hash = bodyHash(body.markdown);
        if (existingHashes.has(hash)) {
          summary.skippedBodies += 1;
          continue;
        }
        await core.addBody({
          noteRef: note.note.id,
          label: body.label,
          markdown: body.markdown
        });
        existingHashes.add(hash);
        summary.addedBodies += 1;
      }
    }

    return summary;
  } finally {
    await close();
  }
}
