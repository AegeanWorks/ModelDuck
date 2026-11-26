import { refusal } from "./external-engines.js";

/**
 * One engine that is in-process by default and external when a load names
 * `engine` (ADR-156). `external` holds ready engines; `resolve(id)` may build
 * one on demand. Switching engines unloads the one that was running, so two
 * never hold the model. With `fallback`, an external engine that cannot start
 * is replaced by the in-process one and the status says so (the app's choice:
 * a saved profile must never leave the user without a model); without it the
 * failure is the result (the tuner's choice).
 */
export class RoutedEngine {
  #inProcess;
  #external;
  #resolve;
  #fallback;
  #current;
  #fellBack = null;

  constructor({ inProcess, external = {}, resolve = null, fallback = false }) {
    this.#inProcess = inProcess;
    this.#external = { ...external };
    this.#resolve = resolve;
    this.#fallback = fallback;
    this.#current = inProcess;
  }

  get #all() {
    return [this.#inProcess, ...Object.values(this.#external)];
  }

  #engineFor(id) {
    if (!id) return this.#inProcess;
    if (!this.#external[id] && this.#resolve) {
      const built = this.#resolve(id);
      if (built) this.#external[id] = built;
    }
    return this.#external[id] ?? null;
  }

  /** The id of the external engine that is running, or null for the in-process one. */
  get engineId() {
    return this.#current === this.#inProcess ? null : this.#current.engineId ?? null;
  }

  get loadedId() {
    return this.#current.loadedId;
  }

  get busy() {
    return this.#current.busy;
  }

  get phase() {
    return this.#current.phase;
  }

  startBackend(backend) {
    return this.#inProcess.startBackend(backend);
  }
  warmRuntime() {
    return this.#inProcess.warmRuntime?.();
  }

  async status() {
    const status = await this.#current.status();
    return this.#fellBack ? { ...status, engineFallback: this.#fellBack } : status;
  }

  async load(options) {
    this.#fellBack = null;
    const wanted = this.#engineFor(options.engine);
    if (!wanted) {
      const why = `${options.engine} is not an engine this machine can use.`;
      if (!this.#fallback) throw refusal("Unknown engine", "engine_unknown", why, `Use one of: ${Object.keys(this.#external).join(", ") || "none configured"}.`, 400);
      return this.#loadInProcess(options, why);
    }
    if (wanted !== this.#current) await this.#current.unload().catch(() => {});
    this.#current = wanted;
    if (wanted === this.#inProcess) return wanted.load(options);
    try {
      return await wanted.load(options);
    } catch (error) {
      if (!this.#fallback) throw error;
      await wanted.unload().catch(() => {});
      return this.#loadInProcess(options, error.why ?? error.message);
    }
  }

  async #loadInProcess(options, reason) {
    const { engine, ...rest } = options;
    this.#current = this.#inProcess;
    this.#fellBack = { wanted: engine, reason };
    return this.#inProcess.load(rest);
  }

  reconfigure(options) {
    return this.#current.reconfigure(options);
  }

  chat(options) {
    return this.#current.chat(options);
  }

  complete(options) {
    return this.#current.complete(options);
  }

  abort(id) {
    return this.#current.abort?.(id) ?? false;
  }

  dropSession(id) {
    return this.#current.dropSession(id);
  }

  async unload() {
    for (const engine of this.#all) await engine.unload().catch(() => {});
    this.#fellBack = null;
  }

  teardown() {
    return this.#current.teardown();
  }

  async dispose() {
    for (const engine of this.#all) await engine.dispose().catch(() => {});
  }
}
