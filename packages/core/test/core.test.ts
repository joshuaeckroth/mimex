import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MimexCore, extractHardLinks } from "../src/index.js";

const tempDirs: string[] = [];

async function newCore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimex-core-test-"));
  tempDirs.push(dir);
  const core = new MimexCore(dir, { autoCommit: false });
  await core.init();
  return core;
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
});

describe("extractHardLinks", () => {
  it("extracts wiki and note protocol links", () => {
    const links = extractHardLinks("Try [[Alpha]] and [beta](note:Beta%20Note)");
    expect(links.map((x) => x.raw)).toEqual(expect.arrayContaining(["Alpha", "Beta Note"]));
  });
});
