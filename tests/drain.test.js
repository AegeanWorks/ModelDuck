import assert from "node:assert/strict";
import test from "node:test";

import { drainServer } from "../src/drain.js";

// IDEA-1024: a fake server records the lifecycle calls in order; a close that
// is not forced stays pending until closeAllConnections is called, like a real
// server that still has a socket attached.
function fakeServer({ forceResolves = true } = {}) {
  const calls = [];
  let finishClose = null;
  const server = {
    close(callback) {
      calls.push("close");
      if (forceResolves) finishClose = callback;
    },
    closeIdleConnections() {
      calls.push("closeIdle");
    },
    closeAllConnections() {
      calls.push("closeAll");
      finishClose?.();
    },
  };
  return { server, calls };
}

function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    elapsed: () => time,
  };
}

test("a server with no work closes at once and reports a drained shutdown", async () => {
  const { server, calls } = fakeServer();
  const clock = fakeClock();
  const result = await drainServer(server, { now: clock.now, wait: clock.wait });
  assert.deepEqual(result, { drained: true, timedOut: false, closed: true });
  assert.deepEqual(calls, ["close", "closeIdle", "closeAll"]);
  assert.equal(clock.elapsed(), 0, "nothing waited");
});

test("an in-flight reply finishes before the connections are force-closed", async () => {
  const { server, calls } = fakeServer();
  const clock = fakeClock();
  let busyPolls = 3;
  const result = await drainServer(server, {
    isBusy: () => busyPolls-- > 0,
    now: clock.now,
    wait: clock.wait,
    pollMs: 100,
    timeoutMs: 1000,
  });
  assert.equal(result.drained, true);
  assert.equal(result.timedOut, false);
  assert.equal(clock.elapsed(), 300, "polled until the reply ended");
  assert.deepEqual(calls, ["close", "closeIdle", "closeIdle", "closeIdle", "closeIdle", "closeAll"]);
});

test("a reply that outlasts the timeout is force-closed and reported as not drained", async () => {
  const { server, calls } = fakeServer();
  const clock = fakeClock();
  const result = await drainServer(server, {
    isBusy: () => true,
    now: clock.now,
    wait: clock.wait,
    pollMs: 100,
    timeoutMs: 250,
  });
  assert.equal(result.drained, false);
  assert.equal(result.timedOut, true);
  assert.equal(clock.elapsed(), 300, "stops at the first poll past the deadline");
  assert.equal(calls.at(-1), "closeAll", "force-closes after the wait");
  assert.equal(calls.filter((call) => call === "closeAll").length, 1);
});

test("close comes before any wait, so no new connection is accepted meanwhile", async () => {
  const { server, calls } = fakeServer();
  const clock = fakeClock();
  let busyPolls = 1;
  await drainServer(server, {
    isBusy: () => busyPolls-- > 0,
    now: clock.now,
    wait: clock.wait,
    pollMs: 100,
  });
  assert.equal(calls[0], "close");
  assert.equal(calls.indexOf("closeAll") > calls.indexOf("closeIdle"), true);
});

test("a server without the optional close helpers still drains", async () => {
  const result = await drainServer(
    { close: (callback) => callback() },
    { isBusy: () => false },
  );
  assert.deepEqual(result, { drained: true, timedOut: false, closed: true });
});
