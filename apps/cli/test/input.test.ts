import { describe, expect, it } from "vitest";
import { normalizeKey, parseLimit, resolveMarkdownInput } from "../src/input.js";

describe("resolveMarkdownInput", () => {
  it("prefers positional markdown", async () => {
    const result = await resolveMarkdownInput({
      positional: "hello",
      markdownOption: "ignored",
      markdownFile: undefined,
      stdinIsTTY: true,
      readStdin: async () => "stdin"
    });

    expect(result).toBe("hello");
  });

  it("reads stdin for positional '-'", async () => {
    const result = await resolveMarkdownInput({
      positional: "-",
      markdownOption: undefined,
      markdownFile: undefined,
      stdinIsTTY: true,
      readStdin: async () => "from-stdin"
    });

    expect(result).toBe("from-stdin");
  });

  it("rejects conflicting markdown options", async () => {
    await expect(
      resolveMarkdownInput({
        positional: undefined,
        markdownOption: "a",
        markdownFile: "b.md",
        stdinIsTTY: true,
        readStdin: async () => ""
      })
    ).rejects.toThrow("use either --markdown or --markdown-file");
  });
});

describe("limit and key helpers", () => {
  it("parses positive integer limit", () => {
    expect(parseLimit("12", 5)).toBe(12);
    expect(parseLimit("0", 5)).toBe(5);
    expect(parseLimit("bad", 5)).toBe(5);
  });

  it("normalizes key consistently", () => {
    expect(normalizeKey("  A   B  ")).toBe("a b");
  });
});
