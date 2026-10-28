import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAccounts, recommend, report } from "./accounts.mjs";

const account = (instanceId, sessionUsed, weeklyUsed) => ({
  instanceId,
  label: instanceId,
  session: { utilization: sessionUsed, resets_at: null },
  weekly: { utilization: weeklyUsed, resets_at: null },
});

test("the emptiest account that can still work is drained first", () => {
  assert.equal(recommend([account("full", 10, 2), account("almost-spent", 4, 94)]).instanceId, "almost-spent");
});

test("an account at its weekly or session limit, or unmeasured, is skipped", () => {
  assert.equal(recommend([account("spent", 0, 99), account("other", 0, 10)]).instanceId, "other");
  assert.equal(recommend([account("busy", 95, 50), account("other", 0, 10)]).instanceId, "other");
  assert.equal(recommend([{ instanceId: "unknown", error: "timeout" }]), null);
  assert.match(report([{ instanceId: "x", label: "X", error: "timeout" }], null), /keep the default instance/);
});

test("accounts are the enabled Claude instances of T3", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3o-"));
  const settingsPath = join(directory, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ providerInstances: {
    personal: { driver: "claudeAgent", displayName: "Me", config: { homePath: "" } },
    work: { driver: "claudeAgent", config: { homePath: "~/.claude_work" } },
    off: { driver: "claudeAgent", enabled: false, config: {} },
    codex: { driver: "codex", config: {} },
  } }));
  const accounts = await readAccounts(settingsPath);
  assert.deepEqual(accounts.map((entry) => entry.instanceId), ["personal", "work"]);
  assert.equal(accounts[0].configDirectory, undefined);
  assert.match(accounts[1].configDirectory, /\/\.claude_work$/);
});
