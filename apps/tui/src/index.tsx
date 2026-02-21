#!/usr/bin/env node
import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { MimexCore } from "@mimex/core";
import type { FollowLinkResult, HardLink, NoteMeta, NoteWithBodies, SoftLinkTarget } from "@mimex/shared-types";

type InputMode = "none" | "search" | "create" | "body" | "follow";
interface CompletionCycle {
  seed: string;
  matches: string[];
  index: number;
}

const defaultWorkspace = process.env.MIMEX_WORKSPACE_PATH ?? path.resolve(process.cwd(), "data/workspaces/local");

function clip(text: string, max = 70): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, max - 3)}...`;
}

function noteStatus(note: NoteMeta): string {
  return note.archivedAt ? "archived" : "active";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

function filterCompletionCandidates(values: string[], seed: string): string[] {
  const source = uniqueSorted(values);
  const query = seed.trim().toLowerCase();
  if (!query) {
    return source;
  }

  const startsWith = source.filter((value) => value.toLowerCase().startsWith(query));
  if (startsWith.length > 0) {
    return startsWith;
  }

  return source.filter((value) => value.toLowerCase().includes(query));
}

function listWindow(notes: NoteMeta[], selectedIndex: number, size = 14): Array<{ note: NoteMeta; selected: boolean }> {
  if (notes.length === 0) {
    return [];
  }

  const start = Math.max(0, Math.min(selectedIndex - Math.floor(size / 2), Math.max(0, notes.length - size)));
  return notes.slice(start, start + size).map((note, idx) => ({
    note,
    selected: start + idx === selectedIndex
  }));
}

function promptForMode(mode: InputMode): string {
  switch (mode) {
    case "search":
      return "Search query";
    case "create":
      return "New note title";
    case "body":
      return "Body markdown";
    case "follow":
      return "Follow target";
    default:
      return "";
  }
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'\"'\"'`)}'`;
}

function App(): React.ReactElement {
  const { exit } = useApp();
  const { setRawMode } = useStdin();
  const [workspace] = useState(defaultWorkspace);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [openedNote, setOpenedNote] = useState<NoteWithBodies | null>(null);
  const [activeBodyIndex, setActiveBodyIndex] = useState(0);
  const [hardLinks, setHardLinks] = useState<HardLink[]>([]);
  const [softLinks, setSoftLinks] = useState<SoftLinkTarget[]>([]);
  const [status, setStatus] = useState("Starting...");
  const [mode, setMode] = useState<InputMode>("none");
  const [inputValue, setInputValue] = useState("");
  const [completionCycle, setCompletionCycle] = useState<CompletionCycle | null>(null);

  const core = useMemo(() => new MimexCore(workspace), [workspace]);
  const selected = notes[selectedIndex] ?? null;
  const titleAndAliasCompletions = useMemo(
    () => uniqueSorted(notes.flatMap((note) => [note.title, ...note.aliases])),
    [notes]
  );
  const noteReferenceCompletions = useMemo(
    () => uniqueSorted(notes.flatMap((note) => [note.id, note.title, ...note.aliases])),
    [notes]
  );
  const hardLinkCompletions = useMemo(() => uniqueSorted(hardLinks.map((link) => link.raw)), [hardLinks]);

  const loadDetails = async (noteRef: string): Promise<void> => {
    const note = await core.getNote(noteRef);
    const links = await core.parseHardLinks(noteRef);
    const soft = await core.getTopSoftLinks(noteRef, 8);
    setOpenedNote(note);
    setActiveBodyIndex((idx) => {
      if (note.bodies.length === 0) {
        return 0;
      }
      return Math.max(0, Math.min(idx, note.bodies.length - 1));
    });
    setHardLinks(links);
    setSoftLinks(soft);
  };

  const refresh = async (preferredId?: string, includeArchivedValue = includeArchived): Promise<void> => {
    setLoading(true);
    try {
      const previousId = preferredId ?? notes[selectedIndex]?.id;
      const listed = await core.listNotes({ includeArchived: includeArchivedValue });
      setNotes(listed);

      if (listed.length === 0) {
        setSelectedIndex(0);
        setOpenedNote(null);
        setHardLinks([]);
        setSoftLinks([]);
        setStatus("No notes yet. Press n to create one.");
        return;
      }

      let nextIndex = 0;
      if (previousId) {
        const found = listed.findIndex((note) => note.id === previousId);
        if (found >= 0) {
          nextIndex = found;
        }
      }

      setSelectedIndex(nextIndex);
      await loadDetails(listed[nextIndex].id);
      setStatus(`Loaded ${listed.length} notes`);
    } catch (error) {
      setStatus(`Error: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const followAndShow = async (sourceId: string, target: string): Promise<void> => {
    const result: FollowLinkResult = await core.followLink(sourceId, target);
    if (result.targetNoteId) {
      await refresh(result.targetNoteId);
      setStatus(`Followed ${result.reason} link to ${result.targetTitle}`);
      return;
    }

    setStatus("No target found");
  };

  const editCurrentBodyInEditor = async (): Promise<void> => {
    if (!openedNote) {
      setStatus("No note selected");
      return;
    }
    if (openedNote.note.archivedAt) {
      setStatus("Cannot edit archived note");
      return;
    }

    let body = openedNote.bodies[activeBodyIndex];
    if (!body) {
      const created = await core.addBody({
        noteRef: openedNote.note.id,
        label: "main",
        markdown: ""
      });
      body = created.bodies[0];
      setOpenedNote(created);
      setActiveBodyIndex(0);
    }

    if (!body) {
      setStatus("Unable to initialize body");
      return;
    }

    const editor = process.env.EDITOR ?? "vi";
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mimex-edit-"));
    const tmpPath = path.join(tmpDir, `${openedNote.note.id}-${body.id}.md`);

    try {
      await writeFile(tmpPath, body.markdown, "utf8");
      setStatus(`Opening editor (${editor})...`);
      setRawMode(false);
      spawnSync("sh", ["-lc", `${editor} ${shellQuote(tmpPath)}`], { stdio: "inherit" });
      setRawMode(true);

      const edited = await readFile(tmpPath, "utf8");
      if (edited === body.markdown) {
        setStatus("No changes saved");
        return;
      }

      await core.updateBody({
        noteRef: openedNote.note.id,
        bodyId: body.id,
        markdown: edited
      });
      await refresh(openedNote.note.id);
      setStatus(`Saved body ${body.label}`);
    } finally {
      setRawMode(true);
      await rm(tmpDir, { recursive: true, force: true });
    }
  };

  useEffect(() => {
    void (async () => {
      await core.init();
      await refresh();
    })();
  }, []);

  useEffect(() => {
    if (!selected) {
      return;
    }

    void (async () => {
      try {
        await loadDetails(selected.id);
      } catch {
        // keep current state if note was changed between renders
      }
    })();
  }, [selectedIndex, notes]);

  const submitInput = async (): Promise<void> => {
    const value = inputValue.trim();
    const currentMode = mode;
    setInputValue("");
    setMode("none");
    setCompletionCycle(null);

    if (!value) {
      setStatus("Cancelled empty input");
      return;
    }

    try {
      if (currentMode === "search") {
        const results = await core.searchNotes(value, 25, { includeArchived });
        if (results.length === 0) {
          setStatus("No matches");
          return;
        }
        await refresh(results[0]?.noteId ?? undefined);
        setStatus(`Search matched ${results.length} notes`);
        return;
      }

      if (currentMode === "create") {
        const created = await core.createNote({ title: value });
        await refresh(created.note.id);
        setStatus(`Created ${created.note.title}`);
        return;
      }

      if (currentMode === "body") {
        if (!selected) {
          setStatus("No note selected");
          return;
        }
        await core.addBody({ noteRef: selected.id, markdown: value, label: `body-${Date.now()}` });
        await refresh(selected.id);
        setStatus("Added body");
        return;
      }

      if (currentMode === "follow") {
        if (!selected) {
          setStatus("No note selected");
          return;
        }
        await followAndShow(selected.id, value);
      }
    } catch (error) {
      setStatus(`Error: ${(error as Error).message}`);
    }
  };

  useEffect(() => {
    setCompletionCycle(null);
  }, [mode]);

  const updateInputValue = (value: string): void => {
    setInputValue(value);
    setCompletionCycle(null);
  };

  const completionCandidatesForMode = (inputMode: InputMode): string[] => {
    if (inputMode === "search") {
      return [...hardLinkCompletions, ...titleAndAliasCompletions];
    }

    if (inputMode === "follow") {
      return [...hardLinkCompletions, ...noteReferenceCompletions];
    }

    if (inputMode === "create") {
      return titleAndAliasCompletions;
    }

    return [];
  };

  const advanceCompletion = (): void => {
    if (mode === "none") {
      return;
    }

    const allowCycle = completionCycle && (inputValue === completionCycle.seed || completionCycle.matches.includes(inputValue));

    if (!allowCycle) {
      const matches = filterCompletionCandidates(completionCandidatesForMode(mode), inputValue);
      if (matches.length === 0) {
        setStatus("No completion candidates");
        return;
      }

      setInputValue(matches[0] ?? inputValue);
      setCompletionCycle({
        seed: inputValue,
        matches,
        index: 0
      });
      setStatus(`Completion 1/${matches.length}`);
      return;
    }

    const nextIndex = (completionCycle.index + 1) % completionCycle.matches.length;
    const nextValue = completionCycle.matches[nextIndex] ?? inputValue;
    setInputValue(nextValue);
    setCompletionCycle({
      ...completionCycle,
      index: nextIndex
    });
    setStatus(`Completion ${nextIndex + 1}/${completionCycle.matches.length}`);
  };

  useInput((input, key) => {
    if (mode !== "none") {
      if (key.tab || input === "\t") {
        advanceCompletion();
        return;
      }

      if (key.escape) {
        setMode("none");
        setInputValue("");
        setCompletionCycle(null);
        setStatus("Input cancelled");
      }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (input === "k" || key.upArrow) {
      setSelectedIndex((idx) => Math.max(0, idx - 1));
      return;
    }

    if (input === "j" || key.downArrow) {
      setSelectedIndex((idx) => Math.min(Math.max(0, notes.length - 1), idx + 1));
      return;
    }

    if (input === "g") {
      setSelectedIndex(0);
      return;
    }

    if (input === "G") {
      setSelectedIndex(Math.max(0, notes.length - 1));
      return;
    }

    if (input === "s") {
      void refresh();
      return;
    }

    if (input === "/") {
      setMode("search");
      setStatus("Search mode");
      return;
    }

    if (input === "n") {
      setMode("create");
      setStatus("Create note mode");
      return;
    }

    if (input === "b") {
      if (!selected) {
        setStatus("No note selected");
        return;
      }
      setMode("body");
      setStatus(`Add body to ${selected.title}`);
      return;
    }

    if (input === "f") {
      if (!selected) {
        setStatus("No note selected");
        return;
      }
      setMode("follow");
      setStatus(`Follow from ${selected.title}`);
      return;
    }

    if (input === "[") {
      setActiveBodyIndex((idx) => Math.max(0, idx - 1));
      return;
    }

    if (input === "]") {
      setActiveBodyIndex((idx) => {
        const max = Math.max(0, (openedNote?.bodies.length ?? 1) - 1);
        return Math.min(max, idx + 1);
      });
      return;
    }

    if (input === "e") {
      void editCurrentBodyInEditor();
      return;
    }

    if (input === "a") {
      if (!selected || selected.archivedAt) {
        return;
      }
      void (async () => {
        try {
          await core.archiveNote(selected.id);
          await refresh();
          setStatus(`Archived ${selected.title}`);
        } catch (error) {
          setStatus(`Error: ${(error as Error).message}`);
        }
      })();
      return;
    }

    if (input === "r") {
      if (!selected || !selected.archivedAt) {
        return;
      }
      void (async () => {
        try {
          await core.restoreNote(selected.id);
          await refresh(selected.id);
          setStatus(`Restored ${selected.title}`);
        } catch (error) {
          setStatus(`Error: ${(error as Error).message}`);
        }
      })();
      return;
    }

    if (input === "x") {
      const next = !includeArchived;
      setIncludeArchived(next);
      void refresh(undefined, next);
      setStatus(next ? "Showing archived notes" : "Hiding archived notes");
    }
  });

  const noteRows = listWindow(notes, selectedIndex);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan">mimex TUI</Text>
        <Text>  workspace={workspace}</Text>
        <Text>  notes={notes.length}</Text>
        <Text>  {includeArchived ? "all" : "active"}</Text>
        <Text>  {loading ? "loading" : "ready"}</Text>
      </Box>

      <Box>
        <Box flexDirection="column" width="45%" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan">Notes</Text>
          {noteRows.length === 0 ? (
            <Text color="gray">No notes</Text>
          ) : (
            noteRows.map(({ note, selected: isSelected }) => (
              <Text key={note.id} color={isSelected ? "green" : "white"}>
                {isSelected ? ">" : " "} {note.title} [{noteStatus(note)}]
              </Text>
            ))
          )}
        </Box>

        <Box flexDirection="column" width="55%" marginLeft={1} borderStyle="round" borderColor="cyan" paddingX={1}>
          {!openedNote ? (
            <Text color="gray">Select a note.</Text>
          ) : (
            <>
              <Text color="green">{openedNote.note.title}</Text>
              <Text>Status: {noteStatus(openedNote.note)}</Text>
              <Text>Bodies: {openedNote.bodies.length}</Text>
              {openedNote.bodies.length > 0 ? (
                openedNote.bodies.slice(0, 4).map((body, idx) => (
                  <Text key={body.id} color={idx === activeBodyIndex ? "yellow" : "white"}>
                    {idx === activeBodyIndex ? ">" : " "} {body.label}: {clip(body.markdown, 60)}
                  </Text>
                ))
              ) : (
                <Text color="gray">(no bodies yet)</Text>
              )}

              <Text color="cyan">Hard links</Text>
              {hardLinks.length === 0 ? (
                <Text color="gray">(none)</Text>
              ) : (
                hardLinks.slice(0, 6).map((link) => <Text key={link.normalized}>- {link.raw}</Text>)
              )}

              <Text color="cyan">Top soft links</Text>
              {softLinks.length === 0 ? (
                <Text color="gray">(none)</Text>
              ) : (
                softLinks.slice(0, 6).map((link) => (
                  <Text key={link.noteId}>
                    - {link.title} (w={link.weight})
                  </Text>
                ))
              )}
            </>
          )}
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        {mode === "none" ? (
          <Text>
            {status} | keys: j/k nav, n new, b body, [/] body pick, e edit($EDITOR), / search, f follow, a archive, r restore, x archived, s refresh, q quit
          </Text>
        ) : (
          <>
            <Text color="yellow">{promptForMode(mode)}: </Text>
            <TextInput value={inputValue} onChange={updateInputValue} onSubmit={() => void submitInput()} />
            <Text color="gray">  (Tab cycles completions, Esc cancels)</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

render(<App />);
