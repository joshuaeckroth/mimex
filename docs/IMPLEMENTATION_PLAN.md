# Mimex Implementation Plan

## Goal

Ship a production-usable v1 of Mimex with:

- note titles with multiple markdown bodies
- hard-link resolution with search fallback
- soft-link accumulation and ranking
- private per-user workspaces
- Git-backed storage with offline-first sync + conflict preservation
- API, MCP, Web UI, TUI, and CLI clients

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
