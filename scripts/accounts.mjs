#!/usr/bin/env node
/**
 * Prints the plan usage of every Claude account configured in T3 Code and recommends the
 * provider instance to launch the next worker on. The coordinator runs it before
 * `t3_thread_launch`; it sends no prompt and consumes no usage.
 *
 * Accounts are the enabled `claudeAgent` instances of T3's settings: each `homePath` is a
 * separate CLAUDE_CONFIG_DIR, so a separate login.
 *
 * Usage relies on the Claude Agent SDK's experimental usage API (the one T3 itself uses). If it
 * fails, the account is reported as unknown and the coordinator falls back to its default.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SETTINGS_PATH = resolve(homedir(), ".t3/userdata/settings.json");
const PROBE_TIMEOUT_MS = 15_000;
// Above these utilizations an account is kept in reserve: a worker could stop mid-task.
const SESSION_LIMIT_PERCENT = 90;
const WEEKLY_LIMIT_PERCENT = 97;

export async function readAccounts(settingsPath = SETTINGS_PATH) {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  return Object.entries(settings.providerInstances ?? {})
    .filter(([, instance]) => instance.driver === "claudeAgent" && instance.enabled !== false)
    .map(([instanceId, instance]) => ({
      instanceId,
      label: instance.displayName ?? instanceId,
      configDirectory: configDirectoryOf(instance.config?.homePath),
    }));
}

function configDirectoryOf(homePath) {
  const trimmed = typeof homePath === "string" ? homePath.trim() : "";
  if (!trimmed) return undefined;
  return resolve(trimmed.replace(/^~(?=$|\/)/, homedir()));
}

async function probeUsage(account) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const environment = { ...process.env };
  // Subscription accounts only: an API key would hide the plan limits.
  delete environment.ANTHROPIC_API_KEY;
  if (account.configDirectory) environment.CLAUDE_CONFIG_DIR = account.configDirectory;
  else delete environment.CLAUDE_CONFIG_DIR;

  const abort = new AbortController();
  // A prompt that never yields lets the SDK initialise without sending any request.
  const idlePrompt = (async function* () {
    await new Promise((done) => abort.signal.addEventListener("abort", done));
  })();
  const session = query({
    prompt: idlePrompt,
    options: { abortController: abort, env: environment, cwd: homedir(), settingSources: [], mcpServers: {}, strictMcpConfig: true },
  });
  const timeout = new Promise((_, fail) => setTimeout(() => fail(new Error("timeout")), PROBE_TIMEOUT_MS).unref());
  try {
    const usage = await Promise.race([
      session.initializationResult()
        .then(() => session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })),
      timeout,
    ]);
    return {
      session: usage.rate_limits?.five_hour ?? null,
      weekly: usage.rate_limits?.seven_day ?? null,
    };
  } finally {
    abort.abort();
  }
}

/**
 * Drains the emptiest usable account first and keeps the fullest in reserve, so quota left on a
 * nearly spent account is used before its reset instead of being lost.
 */
export function recommend(accounts) {
  const usable = accounts.filter((account) =>
    account.weekly?.utilization != null &&
    account.weekly.utilization < WEEKLY_LIMIT_PERCENT &&
    (account.session?.utilization ?? 0) < SESSION_LIMIT_PERCENT);
  usable.sort((first, second) => second.weekly.utilization - first.weekly.utilization);
  return usable[0] ?? null;
}

function formatWindow(window) {
  if (window?.utilization == null) return "unknown";
  const reset = window.resets_at ? `, resets ${window.resets_at.slice(0, 16).replace("T", " ")} UTC` : "";
  return `${Math.round(window.utilization)}% used${reset}`;
}

export function report(accounts, choice) {
  const lines = accounts.map((account) =>
    `- ${account.label} (${account.instanceId}): session ${formatWindow(account.session)}; ` +
    `week ${formatWindow(account.weekly)}${account.error ? `; usage unavailable (${account.error})` : ""}`);
  const verdict = choice
    ? `Launch on instanceId "${choice.instanceId}" (${choice.label}): the emptiest account that can still work.`
    : "No account is clearly usable: keep the default instance and tell the user.";
  return ["Claude accounts:", ...lines, verdict].join("\n");
}

async function main() {
  const accounts = await readAccounts();
  const measured = await Promise.all(accounts.map(async (account) => {
    try {
      return { ...account, ...(await probeUsage(account)) };
    } catch (error) {
      return { ...account, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  console.log(report(measured, recommend(measured)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.log(`Claude accounts: usage unavailable (${error.message}). Keep the default instance.`);
  });
}
