# Importers

## Notion via MCP

`mimex-cli` includes a Notion importer that connects to the Notion MCP server through a bridge command.

Default bridge:

- command: `npx`
- args: `-y mcp-remote https://mcp.notion.com/mcp`

This keeps OAuth/session handling in the bridge and lets Mimex consume MCP tools as stdio.

### Basic usage

Dry-run (plan only):

```bash
mimex-cli import:notion --query "engineering wiki" --dry-run
```

Dry-run all accessible pages:

```bash
mimex-cli import:notion --dry-run --limit 500
```

Run import:

```bash
mimex-cli import:notion --query "engineering wiki"
```

Structured scripting output:

```bash
mimex-cli --porcelain import:notion --query "engineering wiki"
```

### How note creation currently works (`heuristic`)

- Use Notion MCP search tool to discover candidate page references.
- Fetch each candidate page via Notion MCP fetch tool.
- Convert each fetched page to a draft (`title`, `markdown`, `sourceRef`).
- Group drafts by normalized title.
- Create one Mimex note per title.
- Add each draft as a body on that note.
- Skip duplicate bodies by markdown hash.

## LLM-assisted splitting strategy

Use `--strategy llm` with `--planner-command` to split/merge drafts into note plans with better semantic boundaries.

Example:

```bash
mimex-cli import:notion \
  --query "engineering wiki" \
  --strategy llm \
  --planner-command "node scripts/notion-planner.js"
```

### Planner contract

The planner command receives JSON on stdin:

```json
{
  "task": "Split Notion import drafts into Mimex notes and bodies. Output strict JSON: {\"notes\": [...]}",
  "schema": {
    "notes": [
      {
        "title": "string",
        "aliases": ["string"],
        "bodies": [{ "label": "string", "markdown": "string" }],
        "sourceRefs": ["string"]
      }
    ]
  },
  "drafts": [
    {
      "title": "string",
      "markdown": "string",
      "sourceRef": "string",
      "sourceUrl": "string|null"
    }
  ]
}
```

The planner must print JSON to stdout:

```json
{
  "notes": [
    {
      "title": "string",
      "aliases": ["string"],
      "bodies": [{ "label": "string", "markdown": "string" }],
      "sourceRefs": ["string"]
    }
  ]
}
```

### Recommended LLM rules for split quality

- One note per stable concept, not per paragraph.
- Keep original headings and links in markdown.
- Prefer adding bodies to an existing title over creating near-duplicates.
- Promote frequently referenced terms into aliases.
- Keep body labels short and semantic (example: `overview`, `runbook`, `faq`).
