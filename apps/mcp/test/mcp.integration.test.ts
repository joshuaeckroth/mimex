import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}>;

interface RegisteredTools {
  handlers: Map<string, ToolHandler>;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

function registerWithFakeServer(
  registerTools: (server: { registerTool: (...args: any[]) => void }) => void
): RegisteredTools {
  const handlers = new Map<string, ToolHandler>();
  registerTools({
    registerTool(name: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    }
  });
  return { handlers };
}

async function callToolJson(handlers: Map<string, ToolHandler>, name: string, input: Record<string, unknown>) {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`tool not registered: ${name}`);
  }
  const result = await handler(input);
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? `tool ${name} returned error`);
  }
  const text = result.content?.[0]?.text ?? "";
  return JSON.parse(text);
}

async function callToolRaw(handlers: Map<string, ToolHandler>, name: string, input: Record<string, unknown>) {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`tool not registered: ${name}`);
  }
  return handler(input);
}

describe("mcp tool integration", () => {
  const envBackup = {
    workspaceRoot: process.env.MIMEX_WORKSPACE_ROOT,
    defaultUserId: process.env.MIMEX_DEFAULT_USER_ID,
    autoCommit: process.env.MIMEX_AUTO_COMMIT
  };

  let workspaceRoot = "";
  let registerTools: ((server: any) => void) | null = null;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mimex-mcp-test-"));
    process.env.MIMEX_WORKSPACE_ROOT = workspaceRoot;
    process.env.MIMEX_DEFAULT_USER_ID = "local";
    process.env.MIMEX_AUTO_COMMIT = "true";

    const mod = await import("../src/server.ts");
    registerTools = mod.registerTools;
  });

  afterAll(async () => {
    if (envBackup.workspaceRoot === undefined) {
      delete process.env.MIMEX_WORKSPACE_ROOT;
    } else {
      process.env.MIMEX_WORKSPACE_ROOT = envBackup.workspaceRoot;
    }

    if (envBackup.defaultUserId === undefined) {
      delete process.env.MIMEX_DEFAULT_USER_ID;
    } else {
      process.env.MIMEX_DEFAULT_USER_ID = envBackup.defaultUserId;
    }

    if (envBackup.autoCommit === undefined) {
      delete process.env.MIMEX_AUTO_COMMIT;
    } else {
      process.env.MIMEX_AUTO_COMMIT = envBackup.autoCommit;
    }

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("runs an end-to-end tool workflow against a temp git workspace", async () => {
    if (!registerTools) {
      throw new Error("registerTools not initialized");
    }
    const { handlers } = registerWithFakeServer(registerTools);
    const userId = "integration-user";

    const createdSource = await callToolJson(handlers, "mimex_note_create", {
      userId,
      title: "Source",
      markdown: "[[Target]]"
    });
    const sourceId = createdSource.note.note.id as string;

    const createdTarget = await callToolJson(handlers, "mimex_note_create", {
      userId,
      title: "Target",
      markdown: "Destination"
    });
    const targetId = createdTarget.note.note.id as string;

    const followed = await callToolJson(handlers, "mimex_follow_link", {
      userId,
      source: sourceId,
      target: "Target"
    });
    expect(followed.result.targetNoteId).toBe(targetId);
    expect(followed.result.reason).toBe("hard");

    const softLinks = await callToolJson(handlers, "mimex_links_soft", {
      userId,
      noteRef: sourceId,
      limit: 10
    });
    expect(softLinks.count).toBe(1);
    expect(softLinks.links[0].title).toBe("Target");
    expect(softLinks.links[0].weight).toBe(1);

    const withBody = await callToolJson(handlers, "mimex_body_add", {
      userId,
      noteRef: sourceId,
      markdown: "extra body",
      label: "extra"
    });
    const extraBody = withBody.note.note.bodies.find((body: { label: string }) => body.label === "extra");
    expect(extraBody?.id).toBeTruthy();

    const renamedBody = await callToolJson(handlers, "mimex_body_rename", {
      userId,
      noteRef: sourceId,
      bodyId: extraBody?.id,
      label: "secondary"
    });
    expect(renamedBody.note.note.bodies.map((body: { label: string }) => body.label)).toContain("secondary");

    const deletedBody = await callToolJson(handlers, "mimex_body_delete", {
      userId,
      noteRef: sourceId,
      bodyId: extraBody?.id
    });
    expect(deletedBody.note.note.bodies.some((body: { id: string }) => body.id === extraBody?.id)).toBe(false);

    const archived = await callToolJson(handlers, "mimex_note_archive", {
      userId,
      noteRef: sourceId
    });
    expect(archived.note.note.archivedAt).toBeTruthy();

    const listedActive = await callToolJson(handlers, "mimex_note_list", {
      userId,
      includeArchived: false,
      offset: 0,
      limit: 200
    });
    expect(listedActive.total).toBe(1);
    expect(listedActive.notes[0].id).toBe(targetId);

    await callToolJson(handlers, "mimex_note_restore", {
      userId,
      noteRef: sourceId
    });

    const searched = await callToolJson(handlers, "mimex_search_notes", {
      userId,
      query: "target",
      limit: 10
    });
    expect(searched.count).toBeGreaterThanOrEqual(1);

    const info = await callToolJson(handlers, "mimex_workspace_info", {
      userId
    });
    expect(info.notes).toBe(2);
    expect(info.archivedNotes).toBe(0);
    expect(info.softLinkEvents).toBeGreaterThanOrEqual(1);

    const userWorkspace = path.join(workspaceRoot, userId);
    const commits = runGit(userWorkspace, ["log", "--pretty=%s"]).split("\n").filter(Boolean);
    expect(commits).toContain("note: create Source");
    expect(commits).toContain("note: create Target");
    expect(commits.some((subject) => subject.startsWith("soft-link:"))).toBe(true);
    expect(commits.some((subject) => subject.startsWith("note: add body Source"))).toBe(true);
    expect(commits.some((subject) => subject.startsWith("note: rename body Source"))).toBe(true);
    expect(commits.some((subject) => subject.startsWith("note: delete body Source"))).toBe(true);
    expect(commits).toContain("note: archive Source");
    expect(commits).toContain("note: restore Source");
  });

  it("returns structured tool errors for missing notes", async () => {
    if (!registerTools) {
      throw new Error("registerTools not initialized");
    }
    const { handlers } = registerWithFakeServer(registerTools);

    const missing = await callToolRaw(handlers, "mimex_note_get", {
      userId: "errors-user",
      noteRef: "missing-note"
    });

    expect(missing.isError).toBe(true);
    expect(missing.content?.[0]?.text).toMatch(/note not found/i);
  });
});
