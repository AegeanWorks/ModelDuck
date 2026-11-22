/**
 * Read-only GPU backend detection for the Server panel (ADR-019 era /api/gpu route).
 *
 * The native module is loaded once, lazily: the route is polled by the UI and used to be a fresh
 * `import()` on every request. When the runtime is not installed (a source checkout, a broken
 * native build) the endpoint still answers with an empty list instead of a 500, so the panel can
 * say what it knows rather than taking the whole server down.
 */

let detection = null;

export function resetGpuDetection() {
  detection = null;
}

export async function detectGpuBackends() {
  if (!detection) {
    detection = (async () => {
      try {
        const module = await import("node-llama-cpp");
        const backends = await module.getLlamaGpuTypes();
        return Array.isArray(backends) ? backends : [];
      } catch {
        return [];
      }
    })();
  }
  return detection;
}
