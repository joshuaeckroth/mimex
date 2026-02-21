#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { MimexCore } from "@mimex/core";

const defaultWorkspace = process.env.MIMEX_WORKSPACE_PATH ?? path.resolve(process.cwd(), "data/workspaces/local");

function createCore(workspace: string): MimexCore {
  return new MimexCore(workspace);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const program = new Command();
program
  .name("mimex")
  .description("Mimex CLI")
  .option("-w, --workspace <path>", "workspace directory", defaultWorkspace);

program
  .command("note:create")
  .argument("<title>", "note title")
  .option("-m, --markdown <markdown>", "initial markdown body")
  .option("-l, --label <label>", "body label")
  .option("-a, --alias <alias...>", "aliases for title")
  .action(async (title, options) => {
    const core = createCore(program.opts().workspace);
    await core.init();
    const note = await core.createNote({
      title,
      markdown: options.markdown,
      label: options.label,
      aliases: options.alias
    });
    printJson(note);
  });

program
  .command("note:get")
  .argument("<noteRef>", "note id or title")
  .action(async (noteRef) => {
    const core = createCore(program.opts().workspace);
    await core.init();
    const note = await core.getNote(noteRef);
    printJson(note);
  });

program.command("note:list").action(async () => {
  const core = createCore(program.opts().workspace);
  await core.init();
  const notes = await core.listNotes();
  printJson(notes);
});

program
  .command("body:add")
  .argument("<noteRef>", "note id or title")
  .argument("<markdown>", "body markdown")
  .option("-l, --label <label>", "body label")
  .action(async (noteRef, markdown, options) => {
    const core = createCore(program.opts().workspace);
    await core.init();
    const note = await core.addBody({ noteRef, markdown, label: options.label });
    printJson(note);
  });

program
  .command("search")
  .argument("<query>", "search query")
  .option("-l, --limit <number>", "result limit", "10")
  .action(async (query, options) => {
    const core = createCore(program.opts().workspace);
    await core.init();
    const results = await core.searchNotes(query, Number(options.limit));
    printJson(results);
  });

program
  .command("follow")
  .argument("<source>", "source note")
  .argument("<target>", "hard link target text")
  .action(async (source, target) => {
    const core = createCore(program.opts().workspace);
    await core.init();
    const result = await core.followLink(source, target);
    printJson(result);
  });

program
  .command("links:hard")
  .argument("<noteRef>", "note id or title")
  .action(async (noteRef) => {
    const core = createCore(program.opts().workspace);
    await core.init();
    const links = await core.parseHardLinks(noteRef);
    printJson(links);
  });

program
  .command("links:soft")
  .argument("<noteRef>", "note id or title")
  .option("-l, --limit <number>", "result limit", "10")
  .action(async (noteRef, options) => {
    const core = createCore(program.opts().workspace);
    await core.init();
    const links = await core.getTopSoftLinks(noteRef, Number(options.limit));
    printJson(links);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
