import { readFile } from "node:fs/promises";

export interface MarkdownInputOptions {
  positional?: string;
  markdownOption?: string;
  markdownFile?: string;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
}

export async function resolveMarkdownInput(options: MarkdownInputOptions): Promise<string | undefined> {
  const { positional, markdownOption, markdownFile, stdinIsTTY, readStdin } = options;

  if (markdownOption && markdownFile) {
    throw new Error("use either --markdown or --markdown-file, not both");
  }

  if (positional && positional !== "-") {
    return positional;
  }

  if (markdownOption !== undefined) {
    return markdownOption;
  }

  if (markdownFile) {
    return readFile(markdownFile, "utf8");
  }

  if (positional === "-" || !stdinIsTTY) {
    const fromStdin = await readStdin();
    return fromStdin.length > 0 ? fromStdin : undefined;
  }

  return undefined;
}

export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

export function parseLimit(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function normalizeKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}
