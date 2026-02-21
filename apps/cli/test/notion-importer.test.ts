import { describe, expect, it } from "vitest";
import { extractNotionReferencesFromToolResult, planNotesHeuristic } from "../src/importers/notion.js";

describe("notion importer", () => {
  it("extracts notion urls and ids from tool payloads", () => {
    const refs = extractNotionReferencesFromToolResult({
      content: [
        {
          type: "text",
          text: "Result: https://www.notion.so/My-Page-123456781234123412341234567890ab"
        }
      ],
      structuredContent: {
        page_id: "12345678-1234-1234-9234-1234567890ab"
      }
    });

    expect(refs).toContain("https://www.notion.so/My-Page-123456781234123412341234567890ab");
    expect(refs).toContain("12345678-1234-1234-9234-1234567890ab");
    expect(refs).toContain("123456781234123412341234567890ab");
  });

  it("groups heuristic plan by normalized note title", () => {
    const plan = planNotesHeuristic([
      {
        title: "Design Notes",
        markdown: "# Design Notes\nA",
        sourceRef: "ref-a",
        sourceUrl: null
      },
      {
        title: " design   notes ",
        markdown: "# Design Notes\nB",
        sourceRef: "ref-b",
        sourceUrl: "https://www.notion.so/example"
      }
    ]);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.title).toBe("Design Notes");
    expect(plan[0]?.bodies).toHaveLength(2);
    expect(plan[0]?.sourceRefs).toEqual(["ref-a", "ref-b"]);
  });
});
