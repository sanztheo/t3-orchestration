# t3-orchestration — multi-agent orchestration for Claude Code in T3 Code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20%2B%20mod-d97757)
![T3 Code](https://img.shields.io/badge/T3%20Code-orchestration-black)

**Run a whole project from one chat.** t3-orchestration turns [T3 Code](https://github.com/pingdotgg/t3code)
into a multi-agent workspace for [Claude Code](https://code.claude.com): a **coordinator** thread
opens one **worker** thread per topic, every worker **reports back automatically** when its turn
ends, and an optional **memory** thread keeps the project's long-term knowledge with sources.

You talk to the coordinator. It briefs the workers, reads their conversations, and only interrupts
you when you must answer: a plan to approve, a choice, a go-ahead, or finished work.

- 🧭 **Coordinator / worker pattern** for parallel AI coding agents, one topic per thread.
- 🔔 **Automatic end-of-turn notifications** from workers to the coordinator, no polling, no loops.
- 🎯 **Precise role detection** from T3's native metadata: manual threads are never touched.
- 🧠 **Long-term memory** on a schedule: sourced notes, corrections, knowledge pages, SQLite.
- ⚙️ **One-command setup** with a Claude Code skill: `/t3-orchestration:setup`.
- 🔒 No API keys, no server, no telemetry. Everything stays on your machine.

## How it works

Three actors, and only one of them makes a judgement:

| Who | What it is | What it does |
| :- | :- | :- |
| The plugin | a script, no AI | Recognises the coordinator and its workers, injects the right reminder into each prompt, and signals the coordinator when a worker finishes answering |
| A worker | a Claude thread | Does its brief and ends each answer with the real state and the exact question for you |
| The coordinator | a Claude thread | Reads the worker thread on each signal and decides whether you need to hear about it |

```text
 you ──► Coordinator ──t3_thread_launch──► Worker A ─┐
              ▲                            Worker B ─┤  Stop event
              └──────── [T3O_SIGNAL_V1] ◄────────────┘  (queued, deduplicated)
 Memory thread ──every 30 min──► reads threads ──► notes + knowledge pages
```

**Who is who.** On every prompt the plugin asks T3 for the current thread (`t3_thread_configure`)
and its creation metadata (`t3_thread_read`). Titles, folders and prompt text are never used:

- **Coordinator**: the thread id registered for the project.
- **Worker**: a thread of the project created by an agent through MCP whose *first* message was
  sent by the coordinator. A later message from the coordinator does not count.
- **Everything else** gets nothing: threads you create yourself, other projects, subagents,
  archived threads, the memory thread and the setup thread.

**End of turn.** When a worker finishes answering (Claude Code's `Stop` event), the plugin queues
one `[T3O_SIGNAL_V1]` message to the coordinator with the worker's link, never its answer. It has
to happen at `Stop`: by `turn.complete`, T3 has closed the run and refuses the call
(`parent_not_active`). Interrupted turns, subagents and the coordinator itself send nothing, so
there is no automatic loop.

**Memory.** A memory thread runs on a T3 schedule (every 30 minutes by default). Each pass reads
the project's changed threads, records sourced notes with `scripts/memory.py` (SQLite, idempotent
notes, `supersedes` for corrections, revision-checked state) and maintains knowledge pages in a
library folder. It never messages other threads.

## Install

Requirements: T3 Code with its built-in `t3-code` MCP server, Claude Code with mods (tested on
2.1.312), Python 3.9+ for memory.

1. Clone the repository:

   ```bash
   git clone https://github.com/sanztheo/t3-orchestration.git ~/t3-orchestration
   ```

2. In T3 Code's settings, add `--plugin-dir /Users/you/t3-orchestration` to the launch arguments
   of your Claude provider. Use the absolute path: `~` may not be expanded. Or ask a Claude
   thread: *"Read /Users/you/t3-orchestration/skills/setup/SKILL.md and follow it"*.
3. Open a new Claude thread in your project and run `/t3-orchestration:setup`. It asks for a
   project name, the project's rules and whether to enable memory, then creates the coordinator,
   the reminders, the config and the memory thread with its schedule.

Your configuration lives in `~/.t3-orchestration/`, outside the repository. To update, run
`/t3-orchestration:setup` and ask for an update: it pulls the repository and shows you template
changes instead of overwriting your reminders. To add another project, run setup again in it.

## FAQ

**What is t3-orchestration?**
A free, open-source Claude Code plugin that adds a coordinator/worker multi-agent workflow and an
automatic long-term memory to T3 Code, the desktop app that runs Claude Code, Codex and other
coding agents side by side.

**How do workers notify the coordinator?**
A Claude Code mod hooks the `Stop` event of each worker thread and sends one queued message to
the coordinator through T3's `t3_thread_send` MCP tool. The coordinator then reads the worker's
conversation itself.

**Will it touch threads I create myself?**
No. A thread only becomes a worker when its very first message was sent by the coordinator
through MCP. Manual threads receive no reminder and send no signal.

**Does it work with Codex or other agents?**
Not automatically. A Codex hook cannot both read T3's metadata and call a T3 tool, so it cannot
tell a worker from a manual thread. Workers on another provider get a manual reporting protocol
in their brief.

**Does it need an API key or send data anywhere?**
No. It uses your existing Claude Code and T3 Code sessions. Signals contain a thread link only,
never the worker's answer.

## Layout

```text
.claude-plugin/plugin.json   plugin manifest
hooks/register.mjs           the mod: role detection, reminder injection, end-of-turn signal
skills/setup/                install, add a project, update, uninstall
skills/orchestrate/          coordinator and worker rules
skills/memory/               one incremental memory pass
scripts/memory.py            notes and collection state of a library
templates/                   reminders and library pages filled in by setup
config.example.json          shape of ~/.t3-orchestration/config.json
llms.txt                     summary for AI assistants and search engines
```

## Limits

- **Claude Code only** (see the FAQ).
- **The coordinator is an AI.** The plugin guarantees it is told, not that it judges well: it may
  report something minor or miss a question.
- **Best effort.** If T3 is unreachable or slower than 5 seconds, the prompt goes through without a
  reminder and no signal is sent. There are no retries; a crashed process can lose a signal.
- **Failed turns.** A turn that ends on an API error or a rate limit fires `StopFailure`, not
  `Stop`, so it sends no signal: check a worker that seems silent.
- **Managed organisations.** The signal uses a settings-hook event (`classic.Stop`). Where Claude
  Code's built-in mod guard loads (managed settings, or a Team or Enterprise login), such hooks
  in a mod you install do not run: reminders still work, signals do not.
- **T3 tool names.** The plugin relies on the `t3-code` MCP tools listed in
  `skills/setup/SKILL.md`, as available in T3 Code in October 2026. If T3 renames them, the
  plugin stays silent.
- Threads already running load the plugin only after a restart.

## Development

```bash
node --test hooks/register.test.mjs
python3 scripts/test_memory.py
claude plugin validate .
```

Issues and pull requests are welcome.

## License

[MIT](LICENSE) © sanztheo

<!-- Keywords: Claude Code plugin, Claude Code mod, T3 Code, t3code, multi-agent orchestration,
AI coding agents, coordinator worker pattern, agent orchestration, agentic workflow, parallel
agents, long-term memory for AI agents, MCP, Model Context Protocol, Anthropic Claude -->
