# Mimex Implementation Plan (Slim)

## Objective

Ship a reliable, low-ops Mimex v1 that stays local-first and file-first, with one shared core used by API, CLI, TUI, MCP, and a minimal web client.

## Product Scope (v1)

- Notes with one title and multiple markdown bodies.
- Hard-link parsing (`[[...]]` and `note:` links).
- Search fallback when hard-link target is unresolved.
- Soft-link event recording and top related note ranking.
- Per-user workspace isolation by workspace directory.
- Git-backed persistence with automatic commits on mutation.

## Architecture (Current + Target)

- `packages/core` is the source of truth for note logic.
- `apps/api` exposes HTTP endpoints and delegates to core.
- `apps/cli` and `apps/tui` call core directly.
- `apps/mcp` exposes core over MCP stdio tools.
- `apps/web` is a static client that calls `/api/*`.
- Data is on disk under `data/workspaces/<userId>/`:
  - `notes/<noteId>/note.json`
  - `notes/<noteId>/bodies/<bodyId>.md`
  - `.mimex/softlinks.json`
- Core cache is best-effort under `~/.cache/mimex/` (or `$XDG_CACHE_HOME/mimex`).

## Design Principles

- Keep state in files first; avoid external DB dependency for v1.
- Reuse core logic everywhere; avoid duplicated behavior per client.
- Prefer simple deterministic search/ranking over complex indexing.
- Optimize perceived latency with caching and viewport-limited rendering.
- Make deployment cheap and debuggable over highly distributed infra.

## Explicit Non-Goals (v1)

- No Postgres-backed note model.
- No SQLite/FTS indexing service.
- No JWT auth system in this phase.
- No collaborative multi-writer conflict workflow UI.
- No heavy frontend framework requirement.

## Work Plan

## Phase 1: Core Stability and Performance

- Lock core behavior with tests around:
  - note create/get/list/archive/restore/delete
  - body add/update
  - hard-link extraction and follow behavior
  - soft-link accumulation and ranking
- Keep cache behavior predictable:
  - notes metadata cache load on init
  - cache refresh strategy and invalidation paths
  - soft-link cache invalidation on writes
- Address slow paths first in core:
  - avoid repeated note-body reads where possible
  - avoid duplicate search invocations in UI flows

Exit criteria:

- Core tests are green and cover critical flows.
- Large workspaces remain responsive for list/search/follow operations.

## Phase 2: API and MCP Parity

- Keep API endpoints aligned with core capabilities:
  - notes CRUD, body CRUD, search, follow-link, hard-links, soft-links
- Keep MCP tool surface aligned with API/core naming and behavior.
- Document workspace selection model (`x-user-id` or MCP `userId`) and constraints.
- Add lightweight API integration tests for critical paths.

Exit criteria:

- Same user-visible behavior across API, CLI, TUI, and MCP for core flows.
- Error semantics are consistent (not-found, bad input, archived constraints).

## Phase 3: Client UX (Practical, Fast)

- TUI:
  - maintain viewport-based rendering to prevent flashing
  - keep list and body navigation smooth in large notes
  - preserve predictable search and selection behavior
- CLI:
  - stable porcelain output for automation
  - complete command coverage for destructive and non-destructive operations
- Web:
  - minimal grayscale hard-line UI
  - responsive layout for phone and desktop
  - fast list/search/open-note flow

Exit criteria:

- Daily workflows are fast in TUI and CLI.
- Web is usable on mobile and desktop without layout breakage.

## Phase 4: Slim Cloud Deployment

- Keep single-host deploy model:
  - one EC2 host
  - Caddy reverse proxy
  - web + api containers
- Align deployment scripts with actual repo state:
  - add and maintain required Dockerfiles
  - remove unused runtime dependencies from compose
- Keep workspace storage persistent on host volume.

Exit criteria:

- One-command release succeeds end-to-end.
- `/`, `/api/*`, and MCP runtime path are clearly defined and functional.

## Phase 5: Hardening and Operations

- Add practical operational safeguards:
  - health checks
  - structured logs
  - backup/restore steps for workspace data
- Add release checklist:
  - build, tests, smoke checks
  - rollback procedure
- Document incident triage for corrupted note files or git issues.

Exit criteria:

- Operator runbook exists and is tested.
- Recovery steps are straightforward and repeatable.

## Cloud Topology (Slim)

- DNS: root domain -> EC2 Elastic IP.
- TLS: terminated at Caddy on host.
- Routing:
  - `/` -> web container
  - `/api/*` -> api container
  - MCP via stdio process for now, or explicit HTTP bridge when implemented.
- Persistent data:
  - workspace files mounted into API container.
  - optional backups to object storage.

## Risks and Mitigations

- Risk: large workspace degrades list/search latency.
  - Mitigation: cache metadata aggressively, avoid duplicate scans, profile hot paths.
- Risk: drift between docs and deployed reality.
  - Mitigation: keep deployment docs generated from actual scripts/config.
- Risk: MCP transport mismatch in cloud docs.
  - Mitigation: either keep MCP as stdio-only or add a dedicated HTTP MCP bridge and document it explicitly.

## Definition of Done for Slim v1

- Core behavior is tested and stable.
- API, CLI, TUI, and MCP agree on semantics.
- Web client supports practical browse/search/read workflows on phone and desktop.
- Single-host deployment path works without manual fixups.
- Operator documentation matches the running system.
