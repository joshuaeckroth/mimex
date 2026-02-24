import { describe, expect, it } from "vitest";
import {
  buildHashState,
  buildListRows,
  formatEditableNoteContent,
  parseEditedNoteContent,
  parseHashState,
  prependEditErrorComment
} from "../src/state-utils.js";

describe("state-utils", () => {
  it("parses and builds hash state", () => {
    const parsedSimple = parseHashState("#my-note");
    expect(parsedSimple).toEqual({
      noteId: "my-note",
      query: null,
      includeArchived: null
    });

    const parsedQuery = parseHashState("#q=alpha%20beta&archived=yes&note=note-1");
    expect(parsedQuery).toEqual({
      noteId: "note-1",
      query: "alpha beta",
      includeArchived: true
    });

    const hash = buildHashState({
      query: "  alpha beta  ",
      includeArchived: true,
      noteId: "note-1"
    });
    expect(hash).toBe("q=alpha+beta&archived=1&note=note-1");
  });

  it("formats and parses editable note content", () => {
    const formatted = formatEditableNoteContent("Deploy Note", "line 1\nline 2");
    const parsed = parseEditedNoteContent(formatted);
    expect(parsed).toEqual({
      title: "Deploy Note",
      markdown: "line 1\nline 2"
    });
  });

  it("supports leading edit error comments and prepends new errors", () => {
    const content = "%% MIMEX_TITLE: Demo\n\nBody";
    const withError = prependEditErrorComment(content, "invalid --> marker");
    expect(withError.startsWith("<!-- MIMEX_EDIT_ERROR: invalid -- > marker -->\n")).toBe(true);

    const reparsed = parseEditedNoteContent(withError);
    expect(reparsed).toEqual({
      title: "Demo",
      markdown: "Body"
    });
  });

  it("throws when edited content is missing title marker", () => {
    expect(() => parseEditedNoteContent("No marker\n\nBody")).toThrow(/missing title marker/i);
  });

  it("builds list rows from search results or full notes", () => {
    const searchRows = buildListRows({
      query: "alpha",
      searchResults: [{ noteId: "n1", title: "Alpha", score: 0.8 }],
      notes: [{ id: "n2", title: "Beta", bodies: [], archivedAt: null }]
    });
    expect(searchRows).toEqual([
      {
        id: "n1",
        title: "Alpha",
        subtitle: "score 0.8",
        archivedAt: null
      }
    ]);

    const noteRows = buildListRows({
      query: "",
      searchResults: [],
      notes: [
        { id: "n2", title: "Beta", bodies: [{ id: "b1" }, { id: "b2" }], archivedAt: null },
        { id: "n3", title: "Gamma", bodies: [], archivedAt: "2026-02-24T00:00:00.000Z" }
      ]
    });
    expect(noteRows).toEqual([
      {
        id: "n2",
        title: "Beta",
        subtitle: "2 bodies",
        archivedAt: null
      },
      {
        id: "n3",
        title: "Gamma",
        subtitle: "0 bodies",
        archivedAt: "2026-02-24T00:00:00.000Z"
      }
    ]);
  });
});
