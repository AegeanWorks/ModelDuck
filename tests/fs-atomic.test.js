import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonWithQuarantine, writeJsonAtomic, acquireHomeLock, replaceWithRetry } from "../src/fs-atomic.js";

const logger = { warn() {} };

test("writeJsonAtomic replaces a file without leaving temp files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");

  await writeJsonAtomic(file, { version: 1, value: "first" });
  await writeJsonAtomic(file, { version: 1, value: "second" });

  const parsed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(parsed.value, "second");
  const entries = await readFile(file, "utf8");
  assert.match(entries, /\n$/);
});

test("a damaged JSON file is quarantined and the previous backup is restored", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  await writeJsonAtomic(file, { version: 1, value: "first" });
  await writeJsonAtomic(file, { version: 1, value: "second" });
  await writeFile(file, "{not json", "utf8");

  const recovered = await readJsonWithQuarantine(file, { conversations: [] }, { logger });
  assert.deepEqual(recovered, { version: 1, value: "first" });

  const { readdir } = await import("node:fs/promises");
  const names = await readdir(directory);
  assert.ok(names.some((name) => name.startsWith("state.json.corrupt-")));
});

test("a damaged JSON file with no backup falls back safely", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  await writeFile(file, "{not json", "utf8");

  const fallback = await readJsonWithQuarantine(file, { conversations: [] }, { logger });
  assert.deepEqual(fallback, { conversations: [] });
});

test("the home lock is exclusive and released cleanly", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "home.lock");

  const first = await acquireHomeLock(file, { timeoutMs: 200 });
  await assert.rejects(
    () => acquireHomeLock(file, { timeoutMs: 10 }),
    (error) => error.code === "already_running",
  );
  await first.release();
  const second = await acquireHomeLock(file, { timeoutMs: 200 });
  await second.release();
});

test("a lock left by a dead process is taken over immediately", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "home.lock");
  const child = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  assert.ok(Number.isInteger(child.pid), "the probe process ran");
  await writeFile(file, `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() })}\n`, "utf8");

  const lock = await acquireHomeLock(file, { timeoutMs: 200 });
  const held = JSON.parse(await readFile(file, "utf8"));
  assert.equal(held.pid, process.pid, "the new owner replaced the dead lock");
  await lock.release();
});

test("a fresh lock with an unreadable owner is not stolen", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "home.lock");
  await writeFile(file, "{not json", "utf8");

  await assert.rejects(
    () => acquireHomeLock(file, { timeoutMs: 10 }),
    (error) => error.code === "already_running",
  );
});

test("replacing a file retries transient Windows lock errors, then gives up", async () => {
  const failing = (codes) => {
    const calls = [];
    return {
      calls,
      rename: async (from, to) => {
        calls.push([from, to]);
        const code = codes.shift();
        if (code) throw Object.assign(new Error(code), { code });
      },
    };
  };
  const twice = failing(["EPERM", "EBUSY"]);
  await replaceWithRetry("a.tmp", "a", { renameImpl: twice.rename, delayMs: 1 });
  assert.equal(twice.calls.length, 3, "two retries, then success");

  const other = failing(["ENOSPC"]);
  await assert.rejects(replaceWithRetry("a.tmp", "a", { renameImpl: other.rename, delayMs: 1 }), (error) => error.code === "ENOSPC");
  assert.equal(other.calls.length, 1, "a real error is not retried");

  const stuck = failing(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM"]);
  await assert.rejects(replaceWithRetry("a.tmp", "a", { renameImpl: stuck.rename, delayMs: 1 }), (error) => error.code === "EPERM");
  assert.equal(stuck.calls.length, 5, "five tries in all");
});
