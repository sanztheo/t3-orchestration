---
name: setup
description: In T3 Code only, install, configure, update or remove t3-orchestration for a project. Use when the user asks to set up orchestration on a project, add another project, update the plugin, or uninstall it.
---

# Set up t3-orchestration

Run this from a Claude thread in T3 Code, inside the project to orchestrate. Show the user each
change before making it, and ask only for the decisions listed below. The plugin directory is
`${CLAUDE_PLUGIN_ROOT}`. If that text was not replaced by a path, you were asked to read this file
directly: use the directory that contains `skills/setup/SKILL.md` instead.

Requirements: T3 Code with its `t3-code` MCP server exposing `t3_thread_configure`,
`t3_thread_read`, `t3_thread_launch`, `t3_thread_send`, `t3_project_list` and `schedule_task`;
Claude Code with mods (tested on 2.1.312); Python 3.9+ for memory. If a tool is missing, stop and
report it instead of working around it.

All user state lives in `~/.t3-orchestration/`, never in the plugin directory, so updates never
touch it:

```text
~/.t3-orchestration/
├── config.json                  # every orchestrated project
└── projects/<name>/
    ├── coordinator.md           # injected into the coordinator's prompts
    ├── worker.md                # injected into its workers' prompts
    └── library/                 # optional long-term memory
```

## 1. Load the plugin in T3

Skip this step when this skill was invoked as `/t3-orchestration:setup`: the plugin is loaded.

Otherwise the T3 Claude provider must start Claude Code with `--plugin-dir <plugin directory>`.
Prefer letting the user add it to the launch arguments of their Claude provider instance in T3
Code's settings. If they ask you to do it: T3 stores it in `~/.t3/userdata/settings.json`, under
`providerInstances.<id>.config.launchArgs` of an instance whose `driver` is `claudeAgent`. Back up
the file, append the flag to the existing arguments without changing anything else, and show the
diff. Only threads started afterwards load the plugin: ask the user to open a new Claude thread in
the project and run `/t3-orchestration:setup` there.

The plugin is inert in threads it does not recognise, so loading it on a provider used by other
projects is safe.

## 2. Collect the decisions

1. Identify this thread with `t3_thread_configure`, then its project with `t3_thread_read`.
   Confirm the T3 project with the user (`t3_project_list` if it is not this one).
2. Ask for:
   - a project `name`: lowercase letters, digits and dashes;
   - the project rules both roles must follow: repositories, guardrails (production, secrets,
     personal data), delivery process, review policy, language of replies. Keep them short: they
     are injected into every prompt;
   - whether to enable long-term memory, and how often it runs (default every 30 minutes).
3. If `~/.t3-orchestration/config.json` already lists this `projectId` or `name`, stop and ask
   whether to replace it, instead of creating a second coordinator.

## 3. Create the coordinator

Create it idle, without a first message, so that its first turn already receives its reminder:
`t3_thread_launch` with the `projectId`, the title `Orchestration` and no `message`. Keep the
returned `threadId` and `link`. Suggest the user pins it.

## 4. Write the files

1. Create `~/.t3-orchestration/projects/<name>/`.
2. Fill `${CLAUDE_PLUGIN_ROOT}/templates/coordinator.md` and `worker.md`: replace
   `{{PROJECT_NAME}}`, `{{COORDINATOR_THREAD_ID}}` and `{{PROJECT_RULES}}` (a short bullet list).
   Write them as `coordinator.md` and `worker.md` in that directory.
3. With memory: copy `${CLAUDE_PLUGIN_ROOT}/templates/library/` to `library/`, replacing
   `{{PROJECT_NAME}}`, then run
   `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/memory.py" --library "<library path>" status`.
4. Back up `config.json` if it exists, then add this project to `projects`, keeping the others
   (see `${CLAUDE_PLUGIN_ROOT}/config.example.json`). `excludedThreadIds` holds this setup thread's
   id; `memoryThreadId` stays `null` until step 5; `libraryPath` is absolute, or `null`.

## 5. Create the memory thread (optional)

A schedule runs in the thread that creates it, so the memory thread creates its own. Launch it
with `t3_thread_launch` in the same project, titled `Memory`, with this first message, filled in:

> You are the memory thread of `<name>`. Create your own schedule with `schedule_task`:
> `schedule: {type: "interval", everyMs: <interval in ms>}`, `bindToCurrentThread: true`, title
> `<name> memory pass`, prompt `Run one incremental pass with the t3-orchestration:memory skill.`
> Report the schedule id and next run time, then stop. Do not run a pass yet.

Then set `memoryThreadId` in `config.json` to the returned `threadId`. Read the memory thread to
confirm the schedule exists; report its id or the failure exactly.

## 6. Check it end to end

Give the user this check and the links:

1. In the coordinator, send any request. Its context contains `[T3O_COORDINATOR_V1]`.
2. Ask the coordinator to open a small worker thread. The worker's context contains
   `[T3O_WORKER_V1]`, and when its turn ends the coordinator receives `[T3O_SIGNAL_V1]`.
3. In a thread the user creates manually, neither marker appears and no signal is sent.

Report what was created, with the exact links, and what remains unverified.

## Update

1. Note the current commit (`git -C "${CLAUDE_PLUGIN_ROOT}" rev-parse HEAD`), then
   `git -C "${CLAUDE_PLUGIN_ROOT}" pull --ff-only`. Stop on any conflict or local change.
2. Show `git log` and the diff of `templates/` between the two commits. The user's reminder files
   are theirs: propose the template changes, never overwrite them.
3. New threads load the new version; ask the user to restart the threads already running.

## Uninstall

On the user's explicit request only: delete the project's memory schedule
(`list_scheduled_tasks`, then `delete_scheduled_task`) and remove the project from `config.json`.
Remove `--plugin-dir` from the T3 launch arguments only when no project is left: it serves every
configured project. Ask before deleting `~/.t3-orchestration/projects/<name>/`: it holds
the memory library. Threads are kept; archiving them is the user's choice.
