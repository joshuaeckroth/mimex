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
  query?: string;
  limit: number;
  dryRun: boolean;
  mcpCommand: string;
  mcpArgs: string[];
  strategy: "heuristic" | "llm";
  plannerCommand?: string;
  plannerTimeoutMs: number;
  onStatus?: (message: string) => void;
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
type ParsedNotionPayload = {
  title: string | null;
  sourceUrl: string | null;
  markdown: string;
};
type ParsedNotionContent = {
  title: string | null;
  sourceUrl: string | null;
  markdownBlocks: string[];
};
type ParsedNotion404Error = {
  status: 404;
  code: string | null;
  message: string | null;
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

function extractNotionIdLike(value: string): string | null {
  const uuid = value.match(UUID_RE)?.[0];
  if (uuid) {
    return uuid.replace(/-/g, "").toLowerCase();
  }

  const hex = value.match(HEX32_RE)?.[0];
  if (hex) {
    return hex.toLowerCase();
  }

  return null;
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

function sanitizeNotionReference(ref: string, options: { urlOnly?: boolean } = {}): string | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }

  if (isLikelyUrl(trimmed)) {
    const unescaped = trimmed.replace(/\\+$/g, "");

    try {
      const parsed = new URL(unescaped);
      if (!/(?:^|\.)notion\.so$/i.test(parsed.hostname)) {
        return options.urlOnly ? null : unescaped;
      }

      const fromPath = extractNotionIdLike(parsed.pathname);
      if (fromPath) {
        return `https://www.notion.so/${fromPath}`;
      }

      const cleanedPath = parsed.pathname.replace(/(?:%7d)+$/gi, "").replace(/[}\\]+$/g, "");
      if (!cleanedPath || cleanedPath === "/") {
        return null;
      }
      return `https://www.notion.so${cleanedPath}`;
    } catch {
      const fallback = unescaped.replace(/(?:%7d)+$/gi, "").replace(/[}\\]+$/g, "");
      return fallback || null;
    }
  }

  if (options.urlOnly) {
    return null;
  }

  const uuid = trimmed.match(UUID_RE)?.[0];
  if (uuid) {
    return uuid.toLowerCase();
  }
  const hex = trimmed.match(HEX32_RE)?.[0];
  if (hex) {
    return hex.toLowerCase();
  }

  return trimmed;
}

function normalizeNotionRefKey(ref: string): string | null {
  const trimmed = sanitizeNotionReference(ref) ?? ref.trim();
  if (!trimmed) {
    return null;
  }

  if (isLikelyUrl(trimmed)) {
    try {
      const url = new URL(trimmed);
      const fromPath = extractNotionIdLike(url.pathname);
      if (fromPath) {
        return fromPath;
      }
    } catch {
      // ignore URL parse errors; fall back below
    }
  }

  const idLike = extractNotionIdLike(trimmed);
  if (idLike) {
    return idLike;
  }

  return trimmed.toLowerCase();
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

function unwrapNotionContentBlock(text: string): string {
  const content = text.match(/<content>\s*([\s\S]*?)\s*<\/content>/i)?.[1];
  return (content ?? text).replace(/\r\n?/g, "\n");
}

function normalizeNotionPageLinks(markdown: string): string {
  return markdown.replace(/<page\s+url="([^"]+)">([\s\S]*?)<\/page>/gi, (_all, rawUrl: string, rawLabel: string) => {
    const url = rawUrl.replace(/\{\{(https?:\/\/[^}\s]+)\}\}/gi, "$1").trim();
    const label = rawLabel.replace(/\s+/g, " ").trim() || url;
    return `[${label}](${url})`;
  });
}

function sanitizeMimexLinkTarget(input: string): string {
  return input.replace(/\s+/g, " ").trim().replace(/^\[+/, "").replace(/\]+$/, "");
}

function convertNotionInternalLinksToMimexLinks(markdown: string): string {
  let output = markdown.replace(
    /\[([^\]]+)\]\((https?:\/\/(?:www\.)?notion\.so\/[^\s)]+)\)/gi,
    (all, rawLabel: string, _url: string) => {
      const label = sanitizeMimexLinkTarget(rawLabel);
      return label ? `[[${label}]]` : all;
    }
  );

  output = output.replace(
    /(^|[\s(])([^\n<>]+?)\s*<(https?:\/\/(?:www\.)?notion\.so\/[^>\s]+)>/gim,
    (all, prefix: string, rawLabel: string, _url: string) => {
      const label = sanitizeMimexLinkTarget(rawLabel);
      if (!label) {
        return all;
      }
      return `${prefix}[[${label}]]`;
    }
  );

  return output;
}

function normalizeNotionMarkdown(raw: string): string {
  const unwrapped = unwrapNotionContentBlock(raw)
    .replace(/\{\{(https?:\/\/[^}\s]+)\}\}/gi, "$1")
    .replace(/<empty-block\s*\/>/gi, "")
    .trim();
  return convertNotionInternalLinksToMimexLinks(normalizeNotionPageLinks(unwrapped))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseNotionPayloadObject(value: JsonObject): ParsedNotionPayload | null {
  const title = maybeString(value.title);
  const sourceUrl = maybeString(value.url);
  const rawText = maybeString(value.text) ?? maybeString(value.markdown) ?? maybeString(value.content);
  if (!rawText) {
    return null;
  }

  const markdown = normalizeNotionMarkdown(rawText);
  if (!markdown) {
    return null;
  }

  return {
    title,
    sourceUrl,
    markdown
  };
}

function parseNotionPayloadFromUnknown(value: unknown): ParsedNotionPayload | null {
  const rec = asRecord(value);
  if (rec) {
    return parseNotionPayloadObject(rec);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const parsedRec = asRecord(parsed);
    if (!parsedRec) {
      return null;
    }
    return parseNotionPayloadObject(parsedRec);
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string): JsonObject | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function parseNotion404ErrorFromUnknown(value: unknown): ParsedNotion404Error | null {
  const rec = asRecord(value) ?? (typeof value === "string" ? parseJsonRecord(value) : null);
  if (!rec) {
    return null;
  }

  let status: number | null = typeof rec.status === "number" ? rec.status : null;
  let code: string | null = maybeString(rec.code);
  let message: string | null = maybeString(rec.message);
  let isErrorRecord = maybeString(rec.object) === "error" || maybeString(rec.name) === "APIResponseError";

  const embeddedBody =
    typeof rec.body === "string" ? parseJsonRecord(rec.body) : asRecord(rec.body);
  if (embeddedBody) {
    const embeddedStatus = typeof embeddedBody.status === "number" ? embeddedBody.status : null;
    if (status === null && embeddedStatus !== null) {
      status = embeddedStatus;
    }
    code = code ?? maybeString(embeddedBody.code);
    message = message ?? maybeString(embeddedBody.message);
    isErrorRecord = isErrorRecord || maybeString(embeddedBody.object) === "error";
  }

  if (status === 404 && (isErrorRecord || code === "object_not_found")) {
    return {
      status: 404,
      code,
      message
    };
  }

  return null;
}

export function extractNotion404Message(result: McpCallResult): string | null {
  const candidates: unknown[] = [];
  if (result.structuredContent !== undefined) {
    candidates.push(result.structuredContent);
  }

  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) {
      continue;
    }
    candidates.push(rec);
    if (typeof rec.text === "string") {
      candidates.push(rec.text);
    }
  }

  for (const candidate of candidates) {
    const parsed = parseNotion404ErrorFromUnknown(candidate);
    if (!parsed) {
      continue;
    }
    const detail = parsed.message ?? parsed.code ?? "object_not_found";
    return `Notion returned 404: ${detail}`;
  }

  for (const text of allStrings(result)) {
    if (!/could not find page with id|object_not_found/i.test(text)) {
      continue;
    }
    const detail =
      text.match(/Could not find page with ID:[^"\n]+/i)?.[0] ??
      text.match(/object_not_found/i)?.[0] ??
      "object_not_found";
    return `Notion returned 404: ${detail}`;
  }

  return null;
}

export function extractParsedNotionContent(result: McpCallResult): ParsedNotionContent {
  const markdownBlocks: string[] = [];
  let title: string | null = null;
  let sourceUrl: string | null = null;

  const addParsed = (parsed: ParsedNotionPayload | null): void => {
    if (!parsed) {
      return;
    }
    if (!title && parsed.title) {
      title = cleanTitle(parsed.title);
    }
    if (!sourceUrl && parsed.sourceUrl) {
      sourceUrl = parsed.sourceUrl;
    }
    markdownBlocks.push(parsed.markdown);
  };

  addParsed(parseNotionPayloadFromUnknown(result.structuredContent));

  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec || rec.type !== "text" || typeof rec.text !== "string") {
      continue;
    }
    addParsed(parseNotionPayloadFromUnknown(rec.text));
  }

  return {
    title,
    sourceUrl,
    markdownBlocks
  };
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

export function canonicalizeImportedBodyForDedup(markdown: string): string {
  let normalized = markdown.replace(/\r\n?/g, "\n").trim();

  normalized = normalized.replace(/^> Imported from Notion via MCP at [^\n]*\n?/, "");
  normalized = normalized.replace(/^> Source reference: [^\n]*\n?/, "");
  normalized = normalized.replace(/^> Source URL: [^\n]*\n?/, "");

  return normalized.replace(/^\n+/, "").trim();
}

function bodyHash(markdown: string): string {
  return createHash("sha256").update(canonicalizeImportedBodyForDedup(markdown), "utf8").digest("hex");
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

function buildSearchArgs(tool: McpTool, query: string | undefined): JsonObject {
  const properties = new Set(toolInputProperties(tool));
  const args: JsonObject = {};
  const normalizedQuery = (query ?? "").trim();
  const queryValue = normalizedQuery || " ";

  if (properties.has("query")) {
    args.query = queryValue;
  } else if (properties.has("q")) {
    args.q = queryValue;
  } else if (normalizedQuery) {
    const first = [...properties][0];
    if (first) {
      args[first] = normalizedQuery;
    }
  }

  if (!normalizedQuery && properties.has("filter")) {
    args.filter = {
      property: "object",
      value: "page"
    };
  }

  if (properties.has("query_type")) {
    args.query_type = "internal";
  }

  return args;
}

function buildFetchArgs(tool: McpTool, ref: string): JsonObject {
  const properties = new Set(toolInputProperties(tool));
  const args: JsonObject = {};
  const sanitizedRef = sanitizeNotionReference(ref) ?? ref;
  const urlLike = isLikelyUrl(sanitizedRef);
  const refId = extractNotionIdLike(sanitizedRef);

  const urlKeys = ["url", "page_url", "target_url", "resource_url"];
  const idKeys = ["id", "page_id", "database_id", "target_id"];

  const idKey = idKeys.find((key) => properties.has(key));
  if (idKey && refId) {
    args[idKey] = refId;
    return args;
  }

  if (urlLike) {
    const urlKey = urlKeys.find((key) => properties.has(key));
    if (urlKey) {
      args[urlKey] = sanitizedRef;
      return args;
    }
  }

  if (idKey) {
    args[idKey] = sanitizedRef;
    return args;
  }

  const urlKey = urlKeys.find((key) => properties.has(key));
  if (urlKey) {
    args[urlKey] = sanitizedRef;
    return args;
  }

  args.id = refId ?? sanitizedRef;
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
    for (const raw of extractByRegex(text, NOTION_URL_RE)) {
      const normalized = sanitizeNotionReference(raw, { urlOnly: true });
      if (normalized) {
        refs.push(normalized);
      }
    }
    for (const raw of extractByRegex(text, UUID_RE)) {
      const normalized = sanitizeNotionReference(raw);
      if (normalized) {
        refs.push(normalized);
      }
    }
    for (const raw of extractByRegex(text, HEX32_RE)) {
      const normalized = sanitizeNotionReference(raw);
      if (normalized) {
        refs.push(normalized);
      }
    }
  }
  return dedupeRefs(refs);
}

function extractNotionUrlReferencesFromToolResult(result: unknown): string[] {
  const refs: string[] = [];
  for (const text of allStrings(result)) {
    for (const raw of extractByRegex(text, NOTION_URL_RE)) {
      const normalized = sanitizeNotionReference(raw, { urlOnly: true });
      if (normalized) {
        refs.push(normalized);
      }
    }
  }
  return dedupeRefs(refs);
}

export function planNotesHeuristic(drafts: NotionImportDraft[]): NotionImportNotePlan[] {
  const grouped = new Map<string, NotionImportNotePlan>();
  const today = new Date().toISOString().slice(0, 10);

  for (const draft of drafts) {
    const title = cleanTitle(draft.title);
    const key = normalizeKey(title);
    const body: NotionImportBody = {
      label: `notion-import-${today}`,
      markdown: draft.markdown.trim()
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
  const status = (message: string): void => {
    options.onStatus?.(message);
  };
  const summary: NotionImportSummary = {
    strategy: options.strategy,
    query: (options.query ?? "").trim(),
    referencesDiscovered: 0,
    fetchedDocuments: 0,
    plannedNotes: 0,
    createdNotes: 0,
    addedBodies: 0,
    skippedBodies: 0,
    errors: [],
    notes: []
  };

  status(`connecting to MCP bridge: ${options.mcpCommand} ${options.mcpArgs.join(" ")}`.trim());
  const { client, close } = await ensureConnectedClient(options.mcpCommand, options.mcpArgs);
  try {
    status("connected; listing available Notion tools");
    const listed = (await client.listTools()) as { tools?: McpTool[] };
    const tools = listed.tools ?? [];
    const searchTool = chooseTool(tools, ["notion-search", "search"], "search");
    const fetchTool = chooseTool(tools, ["notion-fetch", "fetch"], "fetch");
    status(`using tools: search=${searchTool.name}, fetch=${fetchTool.name}`);

    const searchArgs = buildSearchArgs(searchTool, options.query);
    status(options.query?.trim() ? `searching Notion for "${options.query.trim()}"` : "searching Notion for all accessible pages");
    const searchResult = (await client.callTool({
      name: searchTool.name,
      arguments: searchArgs
    })) as McpCallResult;

    const refByKey = new Map<string, string>();
    const pendingKeys: string[] = [];
    const discoveredKeys = new Set<string>();
    const enqueueRef = (candidate: string): void => {
      const ref = candidate.trim();
      if (!ref) {
        return;
      }
      const key = normalizeNotionRefKey(ref);
      if (!key) {
        return;
      }

      const existing = refByKey.get(key);
      if (!existing || (!isLikelyUrl(existing) && isLikelyUrl(ref))) {
        refByKey.set(key, ref);
      }
      if (!discoveredKeys.has(key)) {
        discoveredKeys.add(key);
        pendingKeys.push(key);
      }
    };

    const seedRefs = extractNotionReferencesFromToolResult(searchResult);
    for (const seed of seedRefs) {
      enqueueRef(seed);
    }
    summary.referencesDiscovered = discoveredKeys.size;
    status(`seeded ${seedRefs.length} refs; unique refs queued=${pendingKeys.length}; fetch limit=${options.limit}`);

    const drafts: NotionImportDraft[] = [];
    let fetchAttempts = 0;

    while (pendingKeys.length > 0 && drafts.length < options.limit) {
      const key = pendingKeys.pop();
      if (!key) {
        continue;
      }
      const ref = refByKey.get(key) ?? key;
      fetchAttempts += 1;
      status(`fetch ${fetchAttempts}: ${ref} (captured=${drafts.length}/${options.limit}, stack=${pendingKeys.length})`);
      try {
        const fetchResult = (await client.callTool({
          name: fetchTool.name,
          arguments: buildFetchArgs(fetchTool, ref)
        })) as McpCallResult;

        const notFoundMessage = extractNotion404Message(fetchResult);
        if (notFoundMessage) {
          summary.errors.push(`${notFoundMessage} (ref: ${ref})`);
          status(`skip: ${notFoundMessage} (ref: ${ref})`);
          continue;
        }

        const parsedNotion = extractParsedNotionContent(fetchResult);
        const textBlocks = parsedNotion.markdownBlocks.length > 0 ? parsedNotion.markdownBlocks : extractTextBlocks(fetchResult);
        const markdown = textBlocks.join("\n\n").trim();
        if (!markdown) {
          summary.errors.push(`empty fetch content for ${ref}`);
          status(`skip: empty fetch content for ${ref}`);
          continue;
        }

        const discoveredRefs = extractNotionReferencesFromToolResult(fetchResult);
        const sourceUrl = parsedNotion.sourceUrl ?? discoveredRefs.find(isLikelyUrl) ?? (isLikelyUrl(ref) ? ref : null);
        const title = parsedNotion.title ?? guessTitleFromFetch(fetchResult, sourceUrl ?? ref);
        drafts.push({
          title,
          markdown,
          sourceRef: ref,
          sourceUrl
        });

        const discoveredBefore = discoveredKeys.size;
        for (const discoveredRef of extractNotionUrlReferencesFromToolResult(fetchResult)) {
          enqueueRef(discoveredRef);
        }
        const discoveredDelta = discoveredKeys.size - discoveredBefore;
        summary.referencesDiscovered = discoveredKeys.size;
        status(
          `captured: "${title}" (${markdown.length} chars); linked pages +${discoveredDelta}; queued=${pendingKeys.length}; unique refs=${summary.referencesDiscovered}`
        );
      } catch (error) {
        summary.errors.push(`fetch failed for ${ref}: ${(error as Error).message}`);
        status(`error: fetch failed for ${ref}: ${(error as Error).message}`);
      }
    }

    summary.fetchedDocuments = drafts.length;
    if (drafts.length >= options.limit) {
      status(`fetch limit reached (${options.limit}); stopping recursion`);
    } else {
      status(`recursion complete; stack drained with ${drafts.length} fetched documents`);
    }

    let plan = planNotesHeuristic(drafts);
    if (options.strategy === "llm") {
      if (!options.plannerCommand) {
        throw new Error("strategy=llm requires --planner-command");
      }
      status(`running planner command (strategy=llm)`);
      plan = await runPlannerCommand(options.plannerCommand, drafts, options.plannerTimeoutMs);
    }

    summary.plannedNotes = plan.length;
    summary.notes = summarizePlan(plan);
    status(`planned ${summary.plannedNotes} note(s) from ${summary.fetchedDocuments} fetched document(s)`);

    if (options.dryRun) {
      status(`dry-run complete: created=0, addedBodies=0, skippedBodies=${summary.skippedBodies}`);
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

    status(`import complete: createdNotes=${summary.createdNotes}, addedBodies=${summary.addedBodies}, skippedBodies=${summary.skippedBodies}`);

    return summary;
  } finally {
    status("closing MCP connection");
    await close();
  }
}
