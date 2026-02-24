import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { MimexCore, extractHardLinks, type MimexCoreOptions } from "../src/index.js";

const tempDirs: string[] = [];

async function newWorkspaceCore(options: MimexCoreOptions = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimex-core-test-"));
  tempDirs.push(dir);
  const core = new MimexCore(dir, {
    autoCommit: false,
    ...options
  });
  await core.init();
  return { core, dir };
}

async function newCore(options: MimexCoreOptions = {}) {
  const { core } = await newWorkspaceCore(options);
  return core;
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

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("MimexCore", () => {
  it("creates notes with multiple bodies", async () => {
    const core = await newCore();
    const first = await core.createNote({ title: "Alpha", markdown: "first body", label: "origin" });
    expect(first.note.title).toBe("Alpha");
    expect(first.note.bodies).toHaveLength(1);

    const updated = await core.addBody({ noteRef: "Alpha", markdown: "second body", label: "extra" });
    expect(updated.note.bodies).toHaveLength(2);
    expect(updated.bodies.map((body) => body.label)).toEqual(expect.arrayContaining(["origin", "extra"]));
  });

  it("resolves hard links and falls back to search", async () => {
    const core = await newCore();
    await core.createNote({ title: "Birds", markdown: "About birds" });
    await core.createNote({ title: "Birdwatching Guide", markdown: "Observe birds in spring" });

    const source = await core.createNote({ title: "Start", markdown: "See [[Birds]] and [[birdwatch tips]]" });
    const links = await core.parseHardLinks(source.note.id);
    expect(links.map((link) => link.raw)).toEqual(expect.arrayContaining(["Birds", "birdwatch tips"]));

    const hard = await core.followLink("Start", "Birds");
    expect(hard.reason).toBe("hard");
    expect(hard.targetTitle).toBe("Birds");

    const fallback = await core.followLink("Start", "birdwatch tips");
    expect(fallback.reason).toBe("search");
    expect(fallback.targetTitle).toBe("Birdwatching Guide");
    expect(fallback.candidates.length).toBeGreaterThan(0);
  });

  it("handles punctuation-heavy multi-word search with phrase and singular matching", async () => {
    const core = await newCore();
    await core.createNote({
      title: "Azure Deployment Runbook",
      aliases: ["Azure deploy"],
      markdown:
        "./push-to-registry.sh --containers \"i2kweb\" i2kconnect.azurecr.io\n\nContainer deployments for canary rollouts."
    });
    await core.createNote({
      title: "Deployment scratchpad",
      markdown: "misc deployment notes without registry hostname"
    });

    const complex = await core.searchNotes("\"azure deployment\" i2kconnect.azurecr.io containers", 5);
    expect(complex[0]?.title).toBe("Azure Deployment Runbook");
    expect(complex[0]?.excerpt.toLowerCase()).toContain("i2kconnect.azurecr.io");

    const singular = await core.searchNotes("container deploy", 5);
    expect(singular.map((row) => row.title)).toContain("Azure Deployment Runbook");
  });

  it("increments soft-link weights", async () => {
    const core = await newCore();
    await core.createNote({ title: "Source", markdown: "[[Target]]" });
    await core.createNote({ title: "Target", markdown: "Destination" });

    await core.followLink("Source", "Target");
    await core.followLink("Source", "Target");

    const top = await core.getTopSoftLinks("Source", 5);
    expect(top).toHaveLength(1);
    expect(top[0]?.title).toBe("Target");
    expect(top[0]?.weight).toBe(2);
  });

  it("archives notes instead of deleting and hides them by default", async () => {
    const core = await newCore();
    await core.createNote({ title: "To Archive", markdown: "body" });
    await core.createNote({ title: "Active", markdown: "body" });
    await core.createNote({ title: "Source", markdown: "[[To Archive]]" });

    const archived = await core.archiveNote("To Archive");
    expect(archived.note.archivedAt).toBeTruthy();

    const listed = await core.listNotes();
    expect(listed.map((note) => note.title).sort()).toEqual(["Active", "Source"]);

    const listedAll = await core.listNotes({ includeArchived: true });
    expect(listedAll.map((note) => note.title).sort()).toEqual(["Active", "Source", "To Archive"]);

    const searchDefault = await core.searchNotes("archive", 10);
    expect(searchDefault.map((row) => row.title)).not.toContain("To Archive");

    const searchAll = await core.searchNotes("archive", 10, { includeArchived: true });
    expect(searchAll.map((row) => row.title)).toContain("To Archive");

    const follow = await core.followLink("Source", "To Archive");
    expect(follow.targetNoteId).toBeNull();
  });

  it("restores archived notes", async () => {
    const core = await newCore();
    await core.createNote({ title: "Restore Me", markdown: "body" });
    await core.archiveNote("Restore Me");

    const restored = await core.restoreNote("Restore Me");
    expect(restored.note.archivedAt).toBeNull();

    const listed = await core.listNotes();
    expect(listed.map((note) => note.title)).toContain("Restore Me");
  });

  it("deletes notes permanently and clears soft-link references", async () => {
    const core = await newCore();
    await core.createNote({ title: "Source", markdown: "[[Target]]" });
    await core.createNote({ title: "Target", markdown: "body" });
    await core.followLink("Source", "Target");

    const deleted = await core.deleteNote("Target");
    expect(deleted.title).toBe("Target");

    const listedAll = await core.listNotes({ includeArchived: true });
    expect(listedAll.map((note) => note.title)).not.toContain("Target");
    await expect(core.getNote("Target")).rejects.toThrow(/note not found/i);

    const top = await core.getTopSoftLinks("Source", 5);
    expect(top).toHaveLength(0);
  });

  it("updates existing body markdown", async () => {
    const core = await newCore();
    const created = await core.createNote({ title: "Editable", markdown: "before" });
    const bodyId = created.note.bodies[0]?.id;
    expect(bodyId).toBeTruthy();

    const updated = await core.updateBody({
      noteRef: "Editable",
      bodyId: bodyId ?? "",
      markdown: "after edit"
    });

    expect(updated.bodies[0]?.markdown).toBe("after edit");
  });

  it("renames note titles and prevents duplicate titles", async () => {
    const core = await newCore();
    const first = await core.createNote({ title: "First Note", markdown: "body" });
    await core.createNote({ title: "Second Note", markdown: "body" });

    const renamed = await core.renameNote(first.note.id, "Renamed First");
    expect(renamed.note.id).toBe(first.note.id);
    expect(renamed.note.title).toBe("Renamed First");

    const byNewTitle = await core.getNote("Renamed First");
    expect(byNewTitle.note.id).toBe(first.note.id);

    await expect(core.renameNote(first.note.id, "Second Note")).rejects.toThrow(/already exists/i);
  });

  it("renames and deletes a single body", async () => {
    const { core, dir } = await newWorkspaceCore();
    const created = await core.createNote({ title: "Body Ops", markdown: "first", label: "main" });
    const withSecond = await core.addBody({ noteRef: created.note.id, markdown: "second", label: "secondary" });
    const secondary = withSecond.note.bodies.find((body) => body.label === "secondary");
    expect(secondary?.id).toBeTruthy();

    const renamed = await core.renameBody({
      noteRef: created.note.id,
      bodyId: secondary?.id ?? "",
      label: "renamed-secondary"
    });
    expect(renamed.note.bodies.map((body) => body.label)).toContain("renamed-secondary");

    const bodyFilePath = path.join(dir, "notes", created.note.id, "bodies", `${secondary?.id}.md`);
    await access(bodyFilePath);

    const afterDelete = await core.deleteBody({
      noteRef: created.note.id,
      bodyId: secondary?.id ?? ""
    });
    expect(afterDelete.note.bodies.find((body) => body.id === secondary?.id)).toBeUndefined();
    await expect(access(bodyFilePath)).rejects.toThrow();
  });

  it("creates real git commits when autoCommit is enabled", async () => {
    const { core, dir } = await newWorkspaceCore({ autoCommit: true });
    runGit(dir, ["config", "user.name", "Mimex Test"]);
    runGit(dir, ["config", "user.email", "mimex-test@example.com"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);

    const created = await core.createNote({ title: "Commit Note", markdown: "first", label: "main" });
    const withSecond = await core.addBody({ noteRef: created.note.id, markdown: "second", label: "secondary" });
    const secondaryBody = withSecond.note.bodies.find((body) => body.label === "secondary");
    expect(secondaryBody?.id).toBeTruthy();

    await core.renameBody({
      noteRef: created.note.id,
      bodyId: secondaryBody?.id ?? "",
      label: "secondary-renamed"
    });
    await core.deleteBody({
      noteRef: created.note.id,
      bodyId: secondaryBody?.id ?? ""
    });
    await core.renameNote(created.note.id, "Commit Note Renamed");

    const subjects = runGit(dir, ["log", "--pretty=%s"]).split("\n").filter(Boolean);
    expect(subjects).toHaveLength(5);
    expect(subjects).toContain("note: create Commit Note");
    expect(subjects).toContain("note: add body Commit Note");
    expect(subjects.some((line) => line.startsWith("note: rename body Commit Note"))).toBe(true);
    expect(subjects.some((line) => line.startsWith("note: delete body Commit Note"))).toBe(true);
    expect(subjects).toContain("note: rename commit-note -> Commit Note Renamed");
  });

  it("persists notes cache to configured cacheDir", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "mimex-core-test-"));
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "mimex-core-cache-test-"));
    tempDirs.push(workspace, cacheDir);

    const core = new MimexCore(workspace, {
      autoCommit: false,
      cacheDir,
      cacheMaxAgeMs: 60_000
    });
    await core.init();
    await core.createNote({ title: "Cached Note", markdown: "body" });
    await core.listNotes({ includeArchived: true });

    const cacheBuckets = (await readdir(cacheDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    expect(cacheBuckets.length).toBeGreaterThan(0);

    const bucketFiles = await readdir(path.join(cacheDir, cacheBuckets[0]?.name ?? ""));
    expect(bucketFiles).toContain("core-cache.json");
  });
});

describe("extractHardLinks", () => {
  it("extracts wiki and note protocol links", () => {
    const links = extractHardLinks("Try [[Alpha]] and [beta](note:Beta%20Note)");
    expect(links.map((x) => x.raw)).toEqual(expect.arrayContaining(["Alpha", "Beta Note"]));
  });
});
