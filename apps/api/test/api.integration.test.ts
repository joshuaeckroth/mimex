import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildMimexApi } from "../src/app.js";

interface Harness {
  app: FastifyInstance;
  workspaceRoot: string;
}

const harnesses: Harness[] = [];

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

async function newHarness(): Promise<Harness> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mimex-api-test-"));
  const app = buildMimexApi({ workspaceRoot, logger: false });
  await app.ready();
  const harness = { app, workspaceRoot };
  harnesses.push(harness);
  return harness;
}

async function injectJson(app: FastifyInstance, options: InjectOptions): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject(options);
  return {
    statusCode: response.statusCode,
    body: response.body ? response.json() : null
  };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0, harnesses.length)) {
    await harness.app.close();
    await rm(harness.workspaceRoot, { recursive: true, force: true });
  }
});

describe("mimex api integration", () => {
  it("executes the note lifecycle over HTTP and writes git commits", async () => {
    const { app, workspaceRoot } = await newHarness();
    const headers = { "x-user-id": "integration-user" };

    const created = await injectJson(app, {
      method: "POST",
      url: "/api/notes",
      headers,
      payload: { title: "Alpha", markdown: "first body", label: "main" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.note.title).toBe("Alpha");
    expect(created.body.note.bodies).toHaveLength(1);
    const noteId = created.body.note.id as string;

    const withBody = await injectJson(app, {
      method: "POST",
      url: `/api/notes/${encodeURIComponent(noteId)}/bodies`,
      headers,
      payload: { markdown: "second body", label: "extra" }
    });
    expect(withBody.statusCode).toBe(201);
    expect(withBody.body.note.bodies).toHaveLength(2);
    const extraBodyId = withBody.body.note.bodies.find((body: { label: string }) => body.label === "extra")?.id as
      | string
      | undefined;
    expect(extraBodyId).toBeTruthy();

    const renamedBody = await injectJson(app, {
      method: "PUT",
      url: `/api/notes/${encodeURIComponent(noteId)}/bodies/${encodeURIComponent(extraBodyId ?? "")}/label`,
      headers,
      payload: { label: "secondary" }
    });
    expect(renamedBody.statusCode).toBe(200);
    expect(renamedBody.body.note.bodies.map((body: { label: string }) => body.label)).toContain("secondary");

    const deletedBody = await injectJson(app, {
      method: "DELETE",
      url: `/api/notes/${encodeURIComponent(noteId)}/bodies/${encodeURIComponent(extraBodyId ?? "")}`,
      headers
    });
    expect(deletedBody.statusCode).toBe(200);
    expect(deletedBody.body.note.bodies).toHaveLength(1);

    const renamedNote = await injectJson(app, {
      method: "PUT",
      url: `/api/notes/${encodeURIComponent(noteId)}/title`,
      headers,
      payload: { title: "Alpha Prime" }
    });
    expect(renamedNote.statusCode).toBe(200);
    expect(renamedNote.body.note.title).toBe("Alpha Prime");

    const searched = await injectJson(app, {
      method: "GET",
      url: "/api/search?q=Alpha%20Prime",
      headers
    });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.map((row: { title: string }) => row.title)).toContain("Alpha Prime");

    const archived = await injectJson(app, {
      method: "POST",
      url: `/api/notes/${encodeURIComponent(noteId)}/archive`,
      headers
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.body.note.archivedAt).toBeTruthy();

    const hiddenArchived = await injectJson(app, {
      method: "GET",
      url: "/api/notes",
      headers
    });
    expect(hiddenArchived.statusCode).toBe(200);
    expect(hiddenArchived.body).toHaveLength(0);

    const includedArchived = await injectJson(app, {
      method: "GET",
      url: "/api/notes?includeArchived=1",
      headers
    });
    expect(includedArchived.statusCode).toBe(200);
    expect(includedArchived.body).toHaveLength(1);
    expect(includedArchived.body[0].title).toBe("Alpha Prime");

    const restored = await injectJson(app, {
      method: "POST",
      url: `/api/notes/${encodeURIComponent(noteId)}/restore`,
      headers
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.body.note.archivedAt).toBeNull();

    const deletedNote = await injectJson(app, {
      method: "DELETE",
      url: `/api/notes/${encodeURIComponent(noteId)}`,
      headers
    });
    expect(deletedNote.statusCode).toBe(200);
    expect(deletedNote.body.id).toBe(noteId);

    const missing = await injectJson(app, {
      method: "GET",
      url: `/api/notes/${encodeURIComponent(noteId)}`,
      headers
    });
    expect(missing.statusCode).toBe(404);

    const userWorkspace = path.join(workspaceRoot, "integration-user");
    const commitSubjects = runGit(userWorkspace, ["log", "--pretty=%s"]).split("\n").filter(Boolean);
    expect(commitSubjects.length).toBeGreaterThanOrEqual(8);
    expect(commitSubjects).toContain("note: create Alpha");
    expect(commitSubjects.some((subject) => subject.startsWith("note: rename body Alpha"))).toBe(true);
    expect(commitSubjects.some((subject) => subject.startsWith("note: delete body Alpha"))).toBe(true);
    expect(commitSubjects).toContain("note: rename alpha -> Alpha Prime");
    expect(commitSubjects).toContain("note: archive Alpha Prime");
    expect(commitSubjects).toContain("note: restore Alpha Prime");
    expect(commitSubjects).toContain("note: delete Alpha Prime");
  });

  it("isolates notes per user id", async () => {
    const { app } = await newHarness();

    await injectJson(app, {
      method: "POST",
      url: "/api/notes",
      headers: { "x-user-id": "alice" },
      payload: { title: "Alice Note", markdown: "a" }
    });
    await injectJson(app, {
      method: "POST",
      url: "/api/notes",
      headers: { "x-user-id": "bob" },
      payload: { title: "Bob Note", markdown: "b" }
    });

    const aliceNotes = await injectJson(app, {
      method: "GET",
      url: "/api/notes",
      headers: { "x-user-id": "alice" }
    });
    const bobNotes = await injectJson(app, {
      method: "GET",
      url: "/api/notes",
      headers: { "x-user-id": "bob" }
    });

    expect(aliceNotes.statusCode).toBe(200);
    expect(aliceNotes.body).toHaveLength(1);
    expect(aliceNotes.body[0].title).toBe("Alice Note");

    expect(bobNotes.statusCode).toBe(200);
    expect(bobNotes.body).toHaveLength(1);
    expect(bobNotes.body[0].title).toBe("Bob Note");
  });
});
