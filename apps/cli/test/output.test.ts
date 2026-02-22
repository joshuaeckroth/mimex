import { describe, expect, it } from "vitest";
import {
  porcelainFollowResult,
  porcelainNoteDeleted,
  porcelainNotesList,
  porcelainSoftLinks,
  renderLinkResolutions,
  type LinkResolution
} from "../src/output.js";

describe("porcelain output", () => {
  it("emits stable note list rows", () => {
    const out = porcelainNotesList([
      {
        id: "alpha",
        title: "Alpha",
        aliases: [],
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        archivedAt: null,
        bodies: []
      }
    ]);

    expect(out).toBe("NOTE\talpha\tAlpha\t0\t2020-01-01T00:00:00.000Z\t");
  });

  it("emits follow result and candidates", () => {
    const out = porcelainFollowResult({
      sourceNoteId: "a",
      targetNoteId: "b",
      targetTitle: "Beta",
      reason: "search",
      candidates: [{ noteId: "b", title: "Beta", score: 8, excerpt: "" }]
    });

    expect(out).toContain("FOLLOW\ta\tb\tBeta\tsearch");
    expect(out).toContain("CANDIDATE\tb\tBeta\t8");
  });

  it("emits soft links", () => {
    const out = porcelainSoftLinks([{ noteId: "n1", title: "N1", weight: 3 }]);
    expect(out).toBe("SOFTLINK\tn1\tN1\t3");
  });

  it("escapes deleted note fields", () => {
    const out = porcelainNoteDeleted({
      id: "n1\t2",
      title: "Line 1\nLine 2",
      aliases: [],
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      archivedAt: null,
      bodies: []
    });
    expect(out).toBe("NOTE_DELETED\tn1 2\tLine 1 Line 2");
  });
});

describe("human output", () => {
  it("renders link resolution candidates", () => {
    const rows: LinkResolution[] = [
      {
        link: "unknown",
        resolution: "search",
        targetNoteId: "x",
        targetTitle: "X",
        candidates: [{ noteId: "x", title: "X", score: 10, excerpt: "" }]
      }
    ];

    const out = renderLinkResolutions(rows);
    expect(out).toContain("unknown -> X (x) [search]");
    expect(out).toContain("candidates: X(10)");
  });
});
