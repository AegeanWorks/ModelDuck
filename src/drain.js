/**
 * IDEA-1024: graceful shutdown.
 *
 * `server.close()` stops new connections but waits for the ones already open;
 * an in-flight reply keeps its connection open until it finishes, and an idle
 * keep-alive socket keeps it open until the client gives up. Shutdown used to
 * call `closeAllConnections()` at once, which truncated the reply a client was
 * reading.
 *
 * The drain closes idle sockets, lets the engine report that it is no longer
 * busy, and only then force-closes whatever is left. The wait is bounded so a
 * stuck reply cannot hold Ctrl+C hostage; the caller can offer a second signal
 * to quit at once.
 */

export const DRAIN_TIMEOUT_MS = 30_000;
export const DRAIN_POLL_MS = 50;

/**
 * @param {{close: Function, closeIdleConnections?: Function, closeAllConnections?: Function}} server
 * @param {object} [options]
 * @param {() => boolean} [options.isBusy] true while a reply or job still runs
 * @param {number} [options.timeoutMs] longest wait before force-closing
 * @param {number} [options.pollMs] pause between busy checks
 * @param {() => number} [options.now] injectable clock for tests
 * @param {(ms: number) => Promise<void>} [options.wait] injectable pause for tests
 * @returns {Promise<{drained: boolean, timedOut: boolean, closed: boolean}>}
 */
export async function drainServer(server, {
  isBusy = () => false,
  timeoutMs = DRAIN_TIMEOUT_MS,
  pollMs = DRAIN_POLL_MS,
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const closed = new Promise((resolve) => {
    server.close(() => resolve(true));
  });
  server.closeIdleConnections?.();
  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  while (isBusy() && now() < deadline) {
    await wait(pollMs);
    server.closeIdleConnections?.();
  }
  const timedOut = Boolean(isBusy());
  server.closeAllConnections?.();
  await closed;
  return { drained: !timedOut, timedOut, closed: true };
}
