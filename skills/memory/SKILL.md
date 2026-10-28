---
name: memory
description: In T3 Code only, run one incremental pass of a project's long-term memory: read the project's threads, record and publish sourced notes, and maintain its knowledge pages. Use in the configured memory thread, when its schedule fires or the user asks for a pass.
---

# Long-term memory pass

This skill belongs to the thread registered as `memoryThreadId` in
`~/.t3-orchestration/config.json`. Check that the current thread id (`t3_thread_configure`) is that
value; otherwise stop and say so. Read the project entry: `projectId`, `excludedThreadIds`,
`coordinatorThreadId` and `libraryPath`.

The memory thread maintains durable knowledge only. It never steers work, never relays between
threads and never messages the coordinator. It changes no code, configuration, permissions,
models or schedules; it runs no tests, builds or deployments, and creates no threads.

All notes and collection state go through the bundled script, with the library path quoted:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/memory.py" --library "<libraryPath>" <command>
```

Commands: `record` and `state-put` read one JSON object on stdin; `publish ID`, `show ID`,
`pending`, `search TEXT`, `state-get KEY`, `state-list`, `refresh`, `backup`, `status`.
A note is `{topic, kind, title, source, body, supersedes?}`; `kind` is one of `decision`,
`observation`, `pitfall`, `procedure`, `artifact`, `correction`; `source` starts with
`t3-thread://v1/`, `https://` or `file://`. `state-put` takes `{key, value, expected_revision}`
with the revision just read by `state-get`.

## Scope

Read threads of `projectId` only, with the native T3 tools, never T3's databases. Pass that
`projectId` explicitly to `t3_thread_list`: the memory thread may live in another project, and the
current project is never the default scope. Skip every id in `excludedThreadIds` and the memory
thread itself before reading; read one of them only when the user explicitly asks to check a
specific source there, and that does not add it back to the collection. Ordinary worker threads
are sources. The coordinator is a source read on every pass (see step 3), never a correspondent.
Follow `POLICY.md` in the library: no secrets, personal data, raw transcripts or audio.

## Incremental pass

1. Read `MEMORY.md` and `POLICY.md` in the library, then `state-get monitor` (its `activationAt`
   and cursors), the `thread:<id>` states and `pending`. The first pass sets `monitor` with
   `activationAt` = now and collects nothing older unless the user asked for a backfill.
2. List the project's threads with `includeSubagents: false`, 100 per page, five pages at most;
   apply the exclusions before any read.
3. Read the coordinator thread directly by its id (`coordinatorThreadId`) from its saved position
   on every pass, even when the listing does not show it: it may live outside the project, and it
   holds most of the user's requests and decisions. Then read the threads changed since their
   saved position, and new threads active since `activationAt`, with `t3_thread_read`. Read the user's requests and approvals, not only an
   agent's conclusion. Usual limit: 30 items per page, three pages per thread, five threads per
   pass; save a resume point when a read is incomplete.
4. Apply "What deserves a note" below, with date and source. Search existing notes before
   creating one.
5. A source is the exact thread link returned by T3, with the message position. Distinguish an
   explicit user decision, an agent's account, an assumption and a verified fact. When a cited
   link is wrong, search for the real thread before declaring the evidence missing. An approval
   the user already gave explicitly is recorded as such, never asked again.
6. `record` the notes, check them, then `publish`. A correction uses `supersedes`. Update the
   knowledge pages concerned and their links in `MEMORY.md`: a published note is not enough while
   an active page still states a rule it contradicts. When evidence is insufficient, keep
   the note pending and say why in this thread.
7. Save receipts before moving cursors, with the current revisions. Only acknowledge a position
   for the part fully read. An error keeps the previous cursor.

## What deserves a note

A note must move the project forward or prevent redoing work. One test: would an agent discovering
this project in a month act differently, or avoid asking again or rediscovering something,
thanks to it? If not, record nothing. A pass with no note is a normal result.

Keep:
- the user's decisions and preferences that hold beyond the current thread, with their reason
  (product rules, how they want work done, delivered or reported);
- costly pitfalls: a constraint of an API or tool, an identified bug, the root cause and fix of
  an incident, a dead end not to try again;
- contracts and invariants discovered, procedures that worked, where artifacts live;
- any correction of earlier knowledge (`supersedes`).

Skip:
- a go-ahead, an "ok" or an approval that only covers one task or batch ("go for these 6
  threads", "ship it"): it is used once and stays in its thread. Only a general rule it states,
  if any, is worth a note;
- progress: thread creation, statuses, ended turns, a pull request number or a count on its own,
  temporary plans;
- an agent's account with no user decision or verified fact, acknowledgements;
- what the code, Git history or docs already say, and what an existing note covers: enrich or
  correct that note instead of adding a neighbour.

Prefer one consolidated note per subject to several small ones. State the rule and its reason,
not the history of the exchange.

## End of pass

Answer briefly in the memory thread: notes and pages updated, missing sources, partial
collection. Send nothing to any other thread. A pass ends after its scope; it starts no timer.
The schedule that triggers passes is owned by the memory thread and changes only on the user's
explicit request. Keep the model and effort the user configured, and do not archive or file the
memory thread.
