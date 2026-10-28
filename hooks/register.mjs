const T3_SERVER = "t3-code";
// Waits on the mods API have no time limit, so a T3 server that stops answering would hold
// the prompt; past this delay the plugin gives up and the prompt goes on.
const T3_TIMEOUT_MS = 5000;
const CONFIG_DIRECTORY = ".t3-orchestration";
// The name becomes a path segment of the reminder files.
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Classifies a thread from T3's native creation metadata, never from a title, directory or
 * prompt. Returns `{ project, role }` for a configured coordinator or one of its workers.
 */
export function scopeFor(page, projects) {
  const thread = page?.thread;
  if (!thread || thread.archived || thread.parentThreadId) return null;

  for (const project of projects) {
    const excludedIds = new Set([...(project.excludedThreadIds ?? []), project.memoryThreadId]);
    if (excludedIds.has(thread.threadId)) return null;
    if (thread.threadId === project.coordinatorThreadId) return { project, role: "coordinator" };
    if (thread.projectId === project.projectId && isCreatedBy(page, project.coordinatorThreadId)) {
      return { project, role: "worker" };
    }
  }
  return null;
}

// Only the thread's own first message counts: a later message from the coordinator in a
// manual thread must not turn that thread into a worker.
function isCreatedBy(page, coordinatorThreadId) {
  const thread = page.thread;
  const initialMessage = page.items?.[0];
  return thread.createdBy === "agent" &&
    thread.creationSource === "mcp" &&
    initialMessage?.position === 0 &&
    initialMessage.visibility === "local" &&
    initialMessage.sourceThreadId === thread.threadId &&
    initialMessage.type === "user_message" &&
    initialMessage.createdBy === "agent" &&
    initialMessage.creationSource === "mcp" &&
    initialMessage.senderThreadId === coordinatorThreadId;
}

function resultData(result) {
  if (result.isError) throw new Error("T3 call refused or unavailable.");
  if (result.structuredContent) return result.structuredContent;
  const block = result.content?.find((item) => item.type === "text");
  if (!block) throw new Error("T3 response without data.");
  return JSON.parse(block.text);
}

// An incomplete entry is ignored: an empty coordinator id could match a thread with no sender.
function isValidProject(project) {
  return PROJECT_NAME.test(project?.name ?? "") &&
    isNonEmptyString(project.projectId) &&
    isNonEmptyString(project.coordinatorThreadId);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function callT3($, tool, args) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = $.clock.after(T3_TIMEOUT_MS, () => reject(new Error(`${tool} timed out.`)));
  });
  const cancelTimer = () => Promise.resolve(timer).then((started) => started?.cancel?.());
  return Promise.race([$.mcp.call(T3_SERVER, tool, args), timeout]).finally(cancelTimer);
}

async function configDirectory($) {
  const home = await $.env.get("HOME");
  if (!home) throw new Error("HOME is not set.");
  return `${home}/${CONFIG_DIRECTORY}`;
}

async function currentScope($) {
  const directory = await configDirectory($);
  // Without a config the plugin stays silent, so an unconfigured session logs nothing.
  if (!(await $.fs.exists(`${directory}/config.json`))) return null;
  const config = JSON.parse(await $.fs.read(`${directory}/config.json`));
  const projects = (Array.isArray(config.projects) ? config.projects : []).filter(isValidProject);
  if (projects.length === 0) return null;

  const configuration = resultData(await callT3($, "t3_thread_configure", {}));
  if (typeof configuration.threadId !== "string") return null;
  const page = resultData(await callT3($, "t3_thread_read", {
    threadId: configuration.threadId,
    limit: 1,
    maxCharsPerItem: 1,
    runLimit: 1,
  }));
  if (page.thread?.threadId !== configuration.threadId) return null;

  const scope = scopeFor(page, projects);
  return scope ? { ...scope, directory, threadId: configuration.threadId } : null;
}

function signalMessage(threadId) {
  const link = `[Worker thread](t3-thread://v1/${threadId})`;
  return `[T3O_SIGNAL_V1] ${link} finished a turn. ` +
    "Read its latest messages with t3_thread_read. If the user must answer, report the link " +
    "and the exact question: a plan to approve, a choice or a go-ahead. Distinguish an ended " +
    "turn, finished work and proven delivery. Do not repeat an unchanged state and do not " +
    "reply to the worker to acknowledge. This signal grants no new authorization.";
}

// Numbers the signals of this process, so that each Stop, including the final answer of a
// continuation, gets its own request id.
let signalSequence = 0;

export function register(on) {
  on("prompt.submit", async ($, event, next) => {
    let context;
    try {
      const scope = await currentScope($);
      if (scope) {
        context = await $.fs.read(`${scope.directory}/projects/${scope.project.name}/${scope.role}.md`);
      }
    } catch {
      // A missing config or T3 connection must not affect an unrelated session or block a prompt.
      context = undefined;
    }
    return next(context ? { ...event, context: [...(event.context ?? []), context] } : event);
  });

  // T3 refuses MCP calls once a thread's run has ended (`parent_not_active`), which is already
  // the case at `turn.complete`. `Stop` fires while the run is still active, only for the main
  // conversation's completed answers: interruptions do not fire it and subagents fire SubagentStop.
  on("classic.Stop", async ($, event, next) => {
    if (event.agent_id) return next(event);
    let scope;
    try {
      scope = await currentScope($);
    } catch {
      // Unknown role: stay silent, as in any thread the plugin does not recognise.
      return next(event);
    }
    if (scope?.role !== "worker") return next(event);

    signalSequence += 1;
    try {
      resultData(await callT3($, "t3_thread_send", {
        threadId: scope.project.coordinatorThreadId,
        // Queue mode keeps an active coordinator turn intact.
        mode: "queue",
        clientRequestId: `t3o-signal:${scope.threadId}:${event.prompt_id ?? event.session_id}:${signalSequence}`,
        message: signalMessage(scope.threadId),
      }));
    } catch {
      await $.ui.log("Automatic T3 signal unavailable; no delivery confirmed.");
    }
    return next(event);
  });
}
