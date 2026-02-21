import { describe, expect, it } from "vitest";
import { extractNotionReferencesFromToolResult, extractParsedNotionContent, planNotesHeuristic } from "../src/importers/notion.js";

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

  it("extracts title and markdown from notion JSON payloads", () => {
    const parsed = extractParsedNotionContent({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Customers",
            url: "https://www.notion.so/9cb302996a6d43598252a50ccbd9a9cb",
            text: "Here is the result of \"view\"\n<content>\n<page url=\"{{https://www.notion.so/a}}\">Alpha</page>\n<empty-block/>\n# Heading\nBody text\n</content>"
          })
        }
      ]
    });

    expect(parsed.title).toBe("Customers");
    expect(parsed.sourceUrl).toBe("https://www.notion.so/9cb302996a6d43598252a50ccbd9a9cb");
    expect(parsed.markdownBlocks).toEqual(["[[Alpha]]\n\n# Heading\nBody text"]);
  });

  it("converts notion internal links to mimex hard links", () => {
    const parsed = extractParsedNotionContent({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Roadmap",
            url: "https://www.notion.so/example-roadmap",
            text: "<content>\nSee [Foo Bar](https://www.notion.so/foo-bar-1234)\nBaz Qux <https://www.notion.so/baz-qux-5678>\n</content>"
          })
        }
      ]
    });

    expect(parsed.markdownBlocks).toEqual(["See [[Foo Bar]]\n[[Baz Qux]]"]);
  });
});
