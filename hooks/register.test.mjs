import assert from "node:assert/strict";
import { test } from "node:test";
import { register, scopeFor } from "./register.mjs";

const coordinatorId = "mcp:coordinator";
const project = {
  name: "demo",
  projectId: "project-1",
  coordinatorThreadId: coordinatorId,
  memoryThreadId: "mcp:memory",
  excludedThreadIds: ["setup-thread"],
};

function workerPage() {
  return {
    thread: {
      threadId: "worker-1",
      projectId: "project-1",
      createdBy: "agent",
      creationSource: "mcp",
      parentThreadId: null,
      archived: false,
    },
    items: [{
      position: 0,
      visibility: "local",
      sourceThreadId: "worker-1",
      type: "user_message",
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: coordinatorId,
    }],
  };
}

function harness(page, { failMcp = false, hangMcp = false, config = { projects: [project] } } = {}) {
  const handlers = new Map();
  const sends = [];
  const logs = [];
  const reads = [];
  register((name, handler) => handlers.set(name, handler));
  const api = {
    env: { get: async (name) => (name === "HOME" ? "/home/user" : undefined) },
    fs: {
      exists: async () => config !== null,
      read: async (path) => {
        reads.push(path);
        return path.endsWith("config.json") ? JSON.stringify(config) : `[REMINDER ${path}]`;
      },
    },
    ui: { log: async (message) => logs.push(message) },
    // Fires at once, so a hanging call times out without waiting.
    clock: { after: (delay, callback) => { const id = setTimeout(callback, 0); return { cancel: () => clearTimeout(id) }; } },
    mcp: {
      call: async (server, tool, args) => {
        assert.equal(server, "t3-code");
        if (failMcp) throw new Error("Disconnected");
        if (hangMcp) return new Promise(() => {});
        if (tool === "t3_thread_configure") return { structuredContent: { threadId: page.thread.threadId } };
        if (tool === "t3_thread_read") return { structuredContent: page };
        sends.push(args);
        return { structuredContent: { delivery: "queued" } };
      },
    },
  };
  return { handlers, api, sends, logs, reads };
}

const passThrough = async (event) => event;

test("only the native creator grants worker scope", () => {
  assert.equal(scopeFor(workerPage(), [project]).role, "worker");

  const laterMessage = workerPage();
  laterMessage.items[0] = { ...laterMessage.items[0], position: 12 };
  assert.equal(scopeFor(laterMessage, [project]), null);

  const otherSender = workerPage();
  otherSender.items[0].senderThreadId = "other-agent";
  assert.equal(scopeFor(otherSender, [project]), null);

  for (const change of [
    { projectId: "other-project" }, { createdBy: "user" }, { parentThreadId: coordinatorId },
    { archived: true }, { threadId: "mcp:memory" }, { threadId: "setup-thread" },
  ]) {
    const page = workerPage();
    Object.assign(page.thread, change);
    assert.equal(scopeFor(page, [project]), null);
  }
  assert.equal(scopeFor(null, [project]), null);
});

test("the coordinator is recognised by its id, even outside the project", () => {
  const page = workerPage();
  Object.assign(page.thread, { threadId: coordinatorId, projectId: "elsewhere", createdBy: "user" });
  assert.equal(scopeFor(page, [project]).role, "coordinator");
});

test("each role receives its own reminder file", async () => {
  for (const [isCoordinator, file] of [[true, "coordinator.md"], [false, "worker.md"]]) {
    const page = workerPage();
    if (isCoordinator) page.thread.threadId = coordinatorId;
    const { handlers, api } = harness(page);
    const result = await handlers.get("prompt.submit")(api, { text: "Hi", context: ["existing"] }, passThrough);
    assert.equal(result.context[0], "existing");
    assert.equal(result.context[1], `[REMINDER /home/user/.t3-orchestration/projects/demo/${file}]`);
  }
});

test("a worker turn queues one signal without copying its answer", async () => {
  const { handlers, api, sends } = harness(workerPage());
  const event = { session_id: "s", prompt_id: "p1", stop_hook_active: false, last_assistant_message: "private answer" };
  assert.equal(await handlers.get("classic.Stop")(api, event, passThrough), event);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].threadId, coordinatorId);
  assert.equal(sends[0].mode, "queue");
  assert.match(sends[0].clientRequestId, /^t3o-signal:worker-1:p1:\d+$/);

  // The final answer of a continuation is signalled too, under its own request id.
  await handlers.get("classic.Stop")(api, { ...event, stop_hook_active: true }, passThrough);
  assert.equal(sends.length, 2);
  assert.notEqual(sends[1].clientRequestId, sends[0].clientRequestId);
  assert.ok(!sends[0].message.includes(event.last_assistant_message));
});

test("coordinator, manual threads and subagents send nothing", async () => {
  const coordinator = workerPage();
  coordinator.thread.threadId = coordinatorId;
  const manual = workerPage();
  manual.items[0].senderThreadId = "manual";
  for (const page of [coordinator, manual]) {
    const { handlers, api, sends } = harness(page);
    await handlers.get("classic.Stop")(api, { session_id: "s" }, passThrough);
    assert.equal(sends.length, 0);
  }

  const { handlers, api, sends } = harness(workerPage());
  await handlers.get("classic.Stop")(api, { session_id: "s", agent_id: "child" }, passThrough);
  assert.equal(sends.length, 0);
});

test("a missing config stays silent and a T3 failure never blocks the prompt", async () => {
  const unconfigured = harness(workerPage(), { config: null });
  const prompt = { text: "Continue" };
  assert.equal(await unconfigured.handlers.get("prompt.submit")(unconfigured.api, prompt, passThrough), prompt);
  await unconfigured.handlers.get("classic.Stop")(unconfigured.api, { session_id: "s" }, passThrough);
  assert.equal(unconfigured.logs.length, 0);

  // T3 down: the role is unknown, so nothing is sent and nothing is logged.
  const broken = harness(workerPage(), { failMcp: true });
  assert.equal(await broken.handlers.get("prompt.submit")(broken.api, prompt, passThrough), prompt);
  await broken.handlers.get("classic.Stop")(broken.api, { session_id: "s" }, passThrough);
  assert.equal(broken.sends.length, 0);
  assert.equal(broken.logs.length, 0);

  const hanging = harness(workerPage(), { hangMcp: true });
  assert.equal(await hanging.handlers.get("prompt.submit")(hanging.api, prompt, passThrough), prompt);
});

test("a failed send to the coordinator is logged in the worker", async () => {
  const { handlers, api, logs } = harness(workerPage());
  const failingSend = api.mcp.call;
  api.mcp.call = async (server, tool, args) => {
    if (tool === "t3_thread_send") return { isError: true, content: [{ type: "text", text: "{}" }] };
    return failingSend(server, tool, args);
  };
  await handlers.get("classic.Stop")(api, { session_id: "s" }, passThrough);
  assert.equal(logs.length, 1);
});

test("an unsafe name or an incomplete project entry is ignored", async () => {
  const unsafe = { ...project, name: "../outside" };
  const { handlers, api, reads } = harness(workerPage(), { config: { projects: [unsafe] } });
  const prompt = { text: "Hi" };
  assert.equal(await handlers.get("prompt.submit")(api, prompt, passThrough), prompt);
  assert.ok(reads.every((path) => !path.includes("..")));

  const noSender = workerPage();
  delete noSender.items[0].senderThreadId;
  const incomplete = { ...project, coordinatorThreadId: null };
  const empty = harness(noSender, { config: { projects: [incomplete] } });
  assert.equal(await empty.handlers.get("prompt.submit")(empty.api, prompt, passThrough), prompt);
});
