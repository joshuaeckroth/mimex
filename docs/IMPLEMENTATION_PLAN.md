# Mimex Implementation Plan

## Goal

Ship a production-usable v1 of Mimex with:

- note titles with multiple markdown bodies
- hard-link resolution with search fallback
- soft-link accumulation and ranking
- private per-user workspaces
- Git-backed storage with offline-first sync + conflict preservation
- API, MCP, Web UI, TUI, and CLI clients

## Detailed product goals

- Knowledge graph first:
  - Notes should feel like a traversable knowledge network, not a flat document list.
  - Every user action that reveals note relationships should improve navigation quality.
- Fast authoring and retrieval:
  - Creating a note/body should be low-friction and always available offline.
  - Finding an intended note from ambiguous text should be reliable via search fallback.
- Durable local truth:
  - Local workspace remains the source of truth for editing and browsing.
  - Sync should never silently drop user content.
- Predictable conflict behavior:
  - Merge conflicts remain explicit in markdown text for user resolution.
  - App should identify conflicting notes and guide users to resolve them quickly.
- Private by default:
  - Each user workspace is isolated at storage and API layers.
  - Cross-user data visibility is impossible without explicit future sharing features.
- Multi-surface consistency:
  - Web, CLI, TUI, and MCP must use shared domain logic so link behavior is identical.

## Workflow and dataflow

### Primary entities

- `Note`:
  - Canonical title, aliases, metadata.
  - Owns one or more `Body` entries.
- `Body`:
  - Markdown document with parsed hard links.
  - Versioned in Git.
- `HardLink`:
  - Explicit markdown link targeting another note title/alias.
- `SoftLinkEvent`:
  - Immutable event emitted when user moves from source note to target note.
- `SoftLinkEdge`:
  - Aggregated weighted edge derived from events.

### Create/edit flow

1. User creates or edits note/body in any client.
2. Client sends command to core via API/CLI/TUI/MCP adapter.
3. Core writes markdown + note metadata to workspace files.
4. Core updates local SQLite derived indexes (title/body/search/link index).
5. Auto-commit worker batches changes into Git commits.
6. UI reflects saved state immediately from local store.

### Read/link-follow flow

1. User opens a note body.
2. Renderer parses hard links in markdown.
3. For each link activation:
   - Try exact/normalized title + alias resolution.
   - If unresolved, tokenize link text and run FTS search.
4. User picks destination note from resolved target or search suggestions.
5. Core records traversal event (`src`, `dst`, `reason`, `delta`, `ts`).
6. Soft-link aggregation updates top related notes for source note.

### Sync/merge flow

1. Background sync loop runs `fetch -> merge -> push` on user workspace remote.
2. Non-conflicting changes merge normally.
3. Conflicting note bodies retain Git conflict markers in markdown files.
4. System marks note as conflict-present for UX surfacing.
5. Derived indexes rebuild/update after merge to keep search/link graph current.

### Request path by interface

- Web:
  - Browser -> API (`/api`) -> core -> filesystem/git/index.
- CLI/TUI:
  - Local command -> API or direct core process -> filesystem/git/index.
- MCP:
  - MCP tool call (`/mcp` or stdio) -> MCP adapter -> core -> filesystem/git/index.

## UX specification

### Information architecture

- Main views:
  - Home/search
  - Note detail
  - Conflict inbox
  - Recent activity
- Note detail regions:
  - Title + aliases
  - Body tabs/switcher
  - Markdown editor/viewer
  - Hard-link suggestions (when unresolved)
  - Top soft links panel

### Authoring UX

- Create note from title-first input.
- Add multiple bodies to same title with labels (for distinct writeups).
- Markdown preview toggle and keyboard shortcuts for quick linking.
- Inline link state badges:
  - resolved hard link
  - unresolved link with suggestion action

### Navigation UX

- Clicking resolved hard link moves directly to destination note.
- Clicking unresolved link opens ranked candidate picker from search fallback.
- Every successful transition updates soft-link graph in background.
- Top soft links show:
  - target title
  - current weight
  - reason summary (hard/search mix)

### Conflict UX

- Dedicated conflict list sorted by most recently synced conflict.
- Note page warning banner when current body contains conflict markers.
- Side-by-side helper:
  - current merged text with markers
  - optional clean base/remote snapshots when available
- Resolve action writes cleaned markdown and commits resolution.

### Cross-surface UX parity

- Same commands and semantics across web/CLI/TUI:
  - create note/body
  - follow link
  - unresolved link candidate pick
  - view top soft links
  - view/resolve conflicts
- CLI and TUI prioritize keyboard-driven flows with minimal prompts.
- Web emphasizes discoverability and visual relationship cues.

## Milestones

## Milestone 0: Monorepo bootstrap (1 week)

- Initialize pnpm + turbo workspace.
- Create app/package layout:
  - `apps/api`, `apps/mcp`, `apps/web`, `apps/cli`, `apps/tui`
  - `packages/core`, `packages/shared-types`
- Add baseline CI (lint, typecheck, unit tests).

Exit criteria:

- All packages build and test in CI.
- Shared lint/type settings are enforced across repo.

## Milestone 1: Core note model + storage (1-2 weeks)

- Implement core entities: `Note`, `Body`, `HardLink`, `SoftLinkEdge`.
- Define on-disk Git-backed layout for notes and bodies.
- Implement create/read/update operations in `packages/core`.
- Add automatic commit batching (debounced commits).

Exit criteria:

- Notes and multi-body writes are persisted in Git repo.
- Commits generated automatically for mutations.

## Milestone 2: Link engine + search (1-2 weeks)

- Parse markdown for hard links.
- Resolve links by canonical title + aliases.
- Add SQLite FTS5 index for title/body lookup.
- Implement unresolved-link search fallback.

Exit criteria:

- Clicking unresolved links returns ranked note candidates.
- Index rebuild from disk is deterministic.

## Milestone 3: Soft-link graph and ranking (1 week)

- Add append-only traversal events (`src`, `dst`, `reason`, `delta`, `ts`).
- Aggregate weighted soft-link edges by note.
- Expose top soft links API from core.

Exit criteria:

- Following hard/search links increments soft-link weights.
- Top-N soft links are stable across restarts and syncs.

## Milestone 4: API + auth + private workspaces (2 weeks)

- Implement Fastify API with JWT auth.
- Add account/workspace metadata (Postgres schema + migrations).
- Map each authenticated user to isolated workspace root.
- Add permission guards for all note and link endpoints.

Exit criteria:

- User cannot access another user workspace data.
- API contract tests cover authz boundary cases.

## Milestone 5: Sync/merge behavior (1-2 weeks)

- Implement background Git sync loop (fetch/merge/push).
- Preserve merge conflict markers in note markdown on conflict.
- Rebuild derived indexes after sync merges.

Exit criteria:

- Concurrent edits from two devices merge without data loss.
- Conflicts remain visible for manual resolution.

## Milestone 6: Client surfaces (2-3 weeks)

- Web app:
  - note viewer/editor
  - multi-body navigation
  - hard-link traversal + unresolved suggestions
  - soft-link sidebar
- CLI and TUI:
  - create/update/search/follow/top-soft-links
- MCP:
  - expose note/search/follow/sync operations

Exit criteria:

- Same core behaviors validated across web/CLI/TUI/MCP.

## Milestone 7: Hardening + observability (1-2 weeks)

- Add structured logs, request IDs, and audit events.
- Add backups/snapshots for host storage and Postgres volume.
- Add smoke tests and release checks in CI.

Exit criteria:

- Recovery drill documented and tested.
- Production health checks and alerts configured.

## Milestone 8: GA readiness (1 week)

- Security review (auth, path traversal, injection, secrets handling).
- Performance pass on search and render hotspots.
- Documentation completion (operator guide + user quickstart).

Exit criteria:

- Release checklist complete.
- v1 tag and changelog published.

## Cross-cutting standards

- Strict TypeScript mode across all packages.
- Contract-first API (Zod schemas reused by clients).
- Test minimums:
  - core domain logic: high unit coverage
  - API behavior: integration coverage for critical flows
  - end-to-end: note creation, linking, search fallback, sync conflict path
