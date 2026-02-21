import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { MimexCore } from "@mimex/core";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const workspaceRoot = process.env.MIMEX_WORKSPACE_ROOT ?? path.resolve(process.cwd(), "data/workspaces");

const coreByUser = new Map<string, MimexCore>();

function normalizeUserId(value: string | undefined): string {
  const cleaned = (value ?? "local").trim();
  if (!cleaned) {
    return "local";
  }

  const safe = cleaned.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return safe || "local";
}

async function getCore(userIdRaw: string | undefined): Promise<MimexCore> {
  const userId = normalizeUserId(userIdRaw);
  const existing = coreByUser.get(userId);
  if (existing) {
    return existing;
  }

  const workspacePath = path.join(workspaceRoot, userId);
  await mkdir(workspacePath, { recursive: true });
  const core = new MimexCore(workspacePath);
  await core.init();
  coreByUser.set(userId, core);
  return core;
}

const createNoteSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  markdown: z.string().optional(),
  label: z.string().optional()
});

const addBodySchema = z.object({
  markdown: z.string(),
  label: z.string().optional()
});

const followLinkSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1)
});

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ ok: true, ts: new Date().toISOString() }));

app.get("/api/notes", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  return core.listNotes();
});

app.post("/api/notes", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  const parsed = createNoteSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const note = await core.createNote(parsed.data);
  return reply.code(201).send(note);
});

app.get("/api/notes/:noteRef", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);

  try {
    return await core.getNote(params.noteRef);
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.post("/api/notes/:noteRef/bodies", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);
  const parsed = addBodySchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  try {
    const note = await core.addBody({ noteRef: params.noteRef, ...parsed.data });
    return reply.code(201).send(note);
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.get("/api/search", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  const query = z
    .object({ q: z.string().min(1), limit: z.coerce.number().int().positive().max(50).optional() })
    .safeParse(request.query);

  if (!query.success) {
    return reply.code(400).send({ error: query.error.flatten() });
  }

  return core.searchNotes(query.data.q, query.data.limit ?? 10);
});

app.post("/api/follow-link", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  const parsed = followLinkSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  try {
    return await core.followLink(parsed.data.source, parsed.data.target);
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.get("/api/notes/:noteRef/hard-links", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);

  try {
    return await core.parseHardLinks(params.noteRef);
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.get("/api/notes/:noteRef/soft-links", async (request, reply) => {
  const core = await getCore(request.headers["x-user-id"] as string | undefined);
  const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);
  const query = z.object({ limit: z.coerce.number().int().positive().max(50).optional() }).safeParse(request.query);

  if (!query.success) {
    return reply.code(400).send({ error: query.error.flatten() });
  }

  try {
    return await core.getTopSoftLinks(params.noteRef, query.data.limit ?? 10);
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

async function start(): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
