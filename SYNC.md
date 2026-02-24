# Sync Strategy and Conflict Scenarios

This file defines how periodic sync works when a workspace Git repo has one or more remotes, and how conflicts are handled for note data.

## Periodic Sync Loop

1. Pick one `primary` remote for pull/rebase. Optional mirror remotes are push-only.
2. Run on an interval (for example every 30s) with a lock to prevent concurrent sync runs.
3. `git fetch --all --prune`.
4. Compare local branch to upstream (`ahead/behind`).
5. If behind only: fast-forward merge.
6. If ahead and behind: rebase onto upstream.
7. If ahead after merge/rebase: push to primary.
8. Optionally push to mirror remotes after primary push succeeds.
9. On any successful update from remote, invalidate caches and refresh UI state.

## File-Level Merge Policy

1. `notes/<id>/bodies/*.md`:
Keep Git conflict markers when overlap happens. This preserves both sides of edits in the body text.
2. `notes/<id>/note.json`:
Do not keep markers; JSON must stay parseable. If auto-resolution cannot produce valid metadata, stop auto-sync and require manual resolution.
3. `.mimex/softlinks.json`:
Do not keep markers; rebuild or structured-merge JSON. If not possible, regenerate from follow events or require manual fix.

## Scenario Matrix

| # | Scenario | Strategy |
|---|---|---|
| 1 | Different notes edited on each side | Auto-merge. No conflict expected. |
| 2 | Same note, different body files edited | Merge body files independently. Structured-merge `note.json` metadata. |
| 3 | Same body file, non-overlapping edits | Auto-merge by Git. |
| 4 | Same body file, overlapping edits | Keep Git markers in that `.md` body and mark note as conflicted in UI status. |
| 5 | Title changed on both sides | Treat as metadata conflict. Prefer deterministic winner (for example remote), store losing title as alias, log sync warning. |
| 6 | Title changed on one side, body changed on other | Apply body merge normally; structured-merge metadata and keep both effects. |
| 7 | Different bodies added on each side | Keep both body files, union body list in `note.json`, refresh updated timestamp. |
| 8 | Body deleted on one side, same body edited on other | Prefer keeping body content by restoring file and keeping conflict markers if needed; mark as delete/edit conflict. |
| 9 | Whole note deleted on one side, note edited on other | Convert delete to archive/tombstone behavior in merge policy: keep note data, mark conflict for review. |
| 10 | Note archived on one side, edited on other | Keep edits and keep archived state only if no new content was added; otherwise unarchive and flag conflict. |
| 11 | Note restored on one side, deleted on other | Prefer restore-with-data-preservation. If delete was intentional, user can delete again after review. |
| 12 | Same note id created independently on both sides | Add/add conflict. Keep both versions by renaming one id (for example `<id>-conflict-<shortsha>`), mark for user review. |
| 13 | Same title created with different ids | Keep both notes; detect duplicate title and auto-add alias suffix or conflict marker note in status. |
| 14 | `.mimex/softlinks.json` changed on both sides | Structured merge by summing/merging weights and deduping events by id; if parse fails, rebuild from event log. |
| 15 | Remote was force-pushed/rebased | Fetch succeeds but rebase may fail; stop auto-sync, require explicit user action (`sync --rebase` or reset policy). |
| 16 | Local uncommitted changes during sync | Do not pull/rebase with dirty worktree. Auto-commit app-managed files first; otherwise skip and report dirty state. |
| 17 | Note deleted then recreated with same id on one side | Treat as delete/add race. Keep recreated note and move older version to archived conflict copy if both exist. |
| 18 | Conflict markers appear in JSON files | Invalid state. Abort sync, surface blocking error, require repair before next sync. |

## Delete-vs-Edit Rule (Important)

When one side deletes a note and the other side edits it, data preservation wins:

1. Keep the note content.
2. Mark conflict state clearly (status/UI/log).
3. Require explicit user confirmation for final deletion later.

This avoids accidental data loss from periodic background sync.

## Multi-Remote Rules

1. Pull/rebase from one upstream only.
2. Push primary first.
3. Push mirrors only after primary succeeds.
4. Mirror push failure does not roll back primary success; it is retried on next cycle.

## Error and Retry Behavior

1. Network/auth failure: exponential backoff with next retry.
2. Push rejected (new remote commits): immediate one retry cycle (fetch/rebase/push), then backoff.
3. Rebase conflict: stop automatic sync until conflict is resolved.

