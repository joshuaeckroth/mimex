import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { MimexCore } from "@mimex/core";

export interface MimexApiOptions {
  workspaceRoot?: string;
  logger?: boolean;
}

export function normalizeUserId(value: string | undefined): string {
  const cleaned = (value ?? "local").trim();
  if (!cleaned) {
    return "local";
  }

  const safe = cleaned.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return safe || "local";
}

function parseIncludeArchived(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return false;
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

const updateBodySchema = z.object({
  markdown: z.string()
});

const renameBodySchema = z.object({
  label: z.string().min(1)
});

const moveBodySchema = z.object({
  targetNoteRef: z.string().trim().min(1)
});

const renameNoteSchema = z.object({
  title: z.string().min(1)
});

const followLinkSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1)
});

const gitSettingsSchema = z.object({
  remoteUrl: z.string(),
  branch: z.string().trim().min(1).optional(),
  authMode: z.enum(["ssh", "https_pat"]).optional(),
  tokenRef: z.string().trim().optional().nullable(),
  token: z.string().optional().nullable()
});

function gitTokenFromHeader(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function buildMimexApi(options: MimexApiOptions = {}): FastifyInstance {
  const workspaceRoot = options.workspaceRoot ?? path.resolve(process.cwd(), "data/workspaces");
  const coreByUser = new Map<string, MimexCore>();

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

  const app = Fastify({ logger: options.logger ?? true });

  app.get("/healthz", async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get("/api/notes", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const query = z.object({ includeArchived: z.any().optional() }).safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return core.listNotes({ includeArchived: parseIncludeArchived(query.data.includeArchived) });
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

  app.put("/api/notes/:noteRef/bodies/:bodyId", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1), bodyId: z.string().min(1) }).parse(request.params);
    const parsed = updateBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const note = await core.updateBody({ noteRef: params.noteRef, bodyId: params.bodyId, markdown: parsed.data.markdown });
      return reply.code(200).send(note);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.put("/api/notes/:noteRef/bodies/:bodyId/label", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1), bodyId: z.string().min(1) }).parse(request.params);
    const parsed = renameBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const note = await core.renameBody({ noteRef: params.noteRef, bodyId: params.bodyId, label: parsed.data.label });
      return reply.code(200).send(note);
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith("note not found") || message.startsWith("body not found")) {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.delete("/api/notes/:noteRef/bodies/:bodyId", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1), bodyId: z.string().min(1) }).parse(request.params);

    try {
      const note = await core.deleteBody({ noteRef: params.noteRef, bodyId: params.bodyId });
      return reply.code(200).send(note);
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith("note not found") || message.startsWith("body not found")) {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/notes/:noteRef/bodies/:bodyId/move", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1), bodyId: z.string().min(1) }).parse(request.params);
    const parsed = moveBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const moved = await core.moveBody({
        noteRef: params.noteRef,
        bodyId: params.bodyId,
        targetNoteRef: parsed.data.targetNoteRef
      });
      return reply.code(200).send(moved);
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith("note not found") || message.startsWith("body not found")) {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.put("/api/notes/:noteRef/title", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);
    const parsed = renameNoteSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const note = await core.renameNote(params.noteRef, parsed.data.title);
      return reply.code(200).send(note);
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith("note not found")) {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/search", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const query = z
      .object({
        q: z.string().min(1),
        limit: z.coerce.number().int().positive().max(50).optional(),
        includeArchived: z.any().optional()
      })
      .safeParse(request.query);

    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }

    return core.searchNotes(query.data.q, query.data.limit ?? 10, {
      includeArchived: parseIncludeArchived(query.data.includeArchived)
    });
  });

  app.post("/api/notes/:noteRef/archive", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);

    try {
      const note = await core.archiveNote(params.noteRef);
      return reply.code(200).send(note);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.post("/api/notes/:noteRef/restore", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);

    try {
      const note = await core.restoreNote(params.noteRef);
      return reply.code(200).send(note);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete("/api/notes/:noteRef", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const params = z.object({ noteRef: z.string().min(1) }).parse(request.params);

    try {
      const note = await core.deleteNote(params.noteRef);
      return reply.code(200).send(note);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
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

  app.get("/api/git/settings", async (request) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const config = await core.getGitRemoteConfig();
    const status = await core.getGitWorkspaceStatus();
    return {
      remoteUrl: config.remoteUrl,
      branch: config.branch,
      authMode: config.authMode,
      tokenRef: config.tokenRef,
      hasAuth: status.hasAuth,
      configured: status.configured
    };
  });

  app.put("/api/git/settings", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    const parsed = gitSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const config = await core.updateGitRemoteConfig(parsed.data);
    const status = await core.getGitWorkspaceStatus();
    return {
      remoteUrl: config.remoteUrl,
      branch: config.branch,
      authMode: config.authMode,
      tokenRef: config.tokenRef,
      hasAuth: status.hasAuth,
      configured: status.configured
    };
  });

  app.get("/api/git/status", async (request) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    return core.getGitWorkspaceStatus();
  });

  app.post("/api/git/pull", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    try {
      await core.gitPull({
        token: gitTokenFromHeader(request.headers["x-mimex-git-token"])
      });
      const status = await core.getGitWorkspaceStatus();
      return { ok: true, action: "pull", status };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post("/api/git/push", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    try {
      await core.gitPush({
        token: gitTokenFromHeader(request.headers["x-mimex-git-token"])
      });
      const status = await core.getGitWorkspaceStatus();
      return { ok: true, action: "push", status };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post("/api/git/sync", async (request, reply) => {
    const core = await getCore(request.headers["x-user-id"] as string | undefined);
    try {
      await core.gitSync({
        token: gitTokenFromHeader(request.headers["x-mimex-git-token"])
      });
      const status = await core.getGitWorkspaceStatus();
      return { ok: true, action: "sync", status };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  return app;
}
