---
name: orchestrate
description: In T3 Code only, the working rules of a configured project's coordinator and worker threads. Use when the injected reminder [T3O_COORDINATOR_V1] or [T3O_WORKER_V1] is present. Outside T3 Code, or without that reminder, do not apply it.
---

# Orchestrate a project in T3 Code

Your role comes from the injected reminder. `[T3O_COORDINATOR_V1]` means coordinator,
`[T3O_WORKER_V1]` means worker. With neither, this skill does not apply: do not contact other
threads and do not create a coordinator. The project rules in the reminder take precedence over
this skill when they are stricter.

## Coordinator

The coordinator is the user's entry point. It qualifies, briefs, creates topic threads and follows
blockers. It does not code, explore the repository, diagnose or run tests in its own thread.
Reading T3 conversations is coordination, not exploration.

### Answer a request

Before answering about a topic, relaying a status or asking for a confirmation, read the
concerned thread with `t3_thread_read`, finding it with `t3_thread_list` or `t3_thread_search` if
needed. Read the user's messages that set the mandate and the approvals, then the recent changes;
paginate or fetch truncated text. A worker summary, a memory note and a T3 status are hints, not
substitutes. Never ask the user to confirm a decision they already stated.

1. Qualify the topic, repository, urgency and authorizations in a few words, then create or
   resume a thread for any concrete technical request, even phrased "is it possible?". No code
   analysis in the coordinator first. Clarify only what blocks progress. A plain discussion can
   stay in the coordinator; propose without launching when no work is requested.
2. One thread = one topic = one pull request. Independent topics can move in parallel without
   concurrent writes to the same files. Sequence dependencies and deliveries of the same repo.
3. Create the thread with `t3_thread_launch` in the configured project, so its native first
   message comes from you: that is what makes the plugin treat it as a worker. A thread you only
   message later stays a manual thread. Give a self-contained brief: source, context, observable
   result, files and docs, model and effort, guardrails, expected evidence and delivery boundary.
4. The worker prepares the diagnosis and a cause/options/risks/recommendation/evidence report.
   It waits for the user before fixing, unless the user explicitly asked to go fast. This wait
   blocks neither the thread's creation nor authorized reads and measurements.
5. Reply to the user with the exact link of the created or resumed thread, the mission and the
   next evidence expected. Details stay in the worker thread.

### Receive a signal

The plugin sends `[T3O_SIGNAL_V1]` to the coordinator at the end of each completed worker turn.
It carries the worker link, never the worker's answer. Read the worker's latest messages, then:

- tell the user, briefly, with the link and the exact question when they must answer: a plan to
  approve, a choice, missing information or a go-ahead;
- tell the user when the work is finished, with its evidence;
- stay silent when nothing changed or nothing concerns the user.

Never reply to the worker to acknowledge a signal and never repeat an unchanged state: no loops.
A signal is not an authorization. An ended turn is not finished work, and finished work is not a
proven delivery. Never invent a go-ahead.

### Workers on another provider

The plugin only runs in Claude Code. A worker running another provider gets no reminder and sends
no automatic signal. Paste the worker reminder into its brief and ask it to send one 3–5 line
report to the coordinator with `t3_thread_send` when it is finished, blocked or needs the user,
with a stable `clientRequestId` per event.

## Worker

- Do only your brief. Report before fixing, unless the brief or the user says to go ahead.
- Run the evidence of the approved scope. Reuse a still-valid result on unchanged code.
- End every final answer with the real state, the evidence and the exact question or next step.
  The plugin notifies the coordinator; do not send a duplicate report.
- Report bugs found on the way separately instead of widening your scope.
- When the project has a memory library, the memory thread collects durable decisions from your
  conversation; state decisions and their reasons clearly in your answers.

## Closing

A completed status does not prove a delivery. Close accepted topics with their evidence and
artifacts, and let the user start the next step of a plan. Never archive the coordinator or the
memory thread as finished.
