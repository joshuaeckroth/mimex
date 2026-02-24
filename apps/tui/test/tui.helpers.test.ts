import { describe, expect, it } from "vitest";
import {
  filterCompletionCandidates,
  formatEditableNoteContent,
  parseEditedNoteContent,
  prependEditErrorComment,
  resolveInitialTheme,
  uniqueSorted
} from "../src/index.js";

describe("tui helper functions", () => {
  it("resolves the startup theme from env values", () => {
    expect(resolveInitialTheme(undefined)).toBe("dark");
    expect(resolveInitialTheme("light")).toBe("light");
    expect(resolveInitialTheme("LiGhT")).toBe("light");
    expect(resolveInitialTheme("dark")).toBe("dark");
    expect(resolveInitialTheme("unknown")).toBe("dark");
  });

  it("round-trips editable note content with title marker", () => {
    const formatted = formatEditableNoteContent("Deploy Note", "line 1\nline 2");
    const parsed = parseEditedNoteContent(formatted);
    expect(parsed).toEqual({
      title: "Deploy Note",
      markdown: "line 1\nline 2"
    });
  });

  it("preserves parseability when prepending edit errors", () => {
    const edited = "%% MIMEX_TITLE: Alpha\n\nBody";
    const withError = prependEditErrorComment(edited, "invalid --> marker");
    expect(withError.startsWith("<!-- MIMEX_EDIT_ERROR: invalid -- > marker -->\n")).toBe(true);

    const parsed = parseEditedNoteContent(withError);
    expect(parsed).toEqual({
      title: "Alpha",
      markdown: "Body"
    });
  });

  it("throws on malformed edited content", () => {
    expect(() => parseEditedNoteContent("No title marker\n\nBody")).toThrow(/missing title marker/i);
    expect(() => parseEditedNoteContent("%% MIMEX_TITLE:\n\nBody")).toThrow(/title marker is empty/i);
  });

  it("normalizes completion candidates and prefers prefix matches", () => {
    expect(uniqueSorted([" beta ", "Alpha", "alpha", ""])).toEqual(["Alpha", "alpha", "beta"]);

    const values = ["Deploy", "Docker", "Link Target", "Other"];
    expect(filterCompletionCandidates(values, "")).toEqual(["Deploy", "Docker", "Link Target", "Other"]);
    expect(filterCompletionCandidates(values, "do")).toEqual(["Docker"]);
    expect(filterCompletionCandidates(values, "target")).toEqual(["Link Target"]);
  });
});
