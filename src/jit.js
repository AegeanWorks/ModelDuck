import { AppError } from "./errors.js";

function sameModel(entry, reference) {
  if (!entry || !reference) return false;
  const value = String(reference).toLowerCase().replace(/\.gguf$/i, "");
  return (
    entry.id.toLowerCase() === value ||
    entry.fileName.toLowerCase().replace(/\.gguf$/i, "") === value ||
    entry.name.toLowerCase() === value
  );
}

export class JitManager {
  #engine;
  #registry;
  #settings;
  #serverSettings;
  #tuned;
  #logger;
  #trackedId = null;
  #timer = null;

  constructor({ engine, registry, settings, serverSettings, tuned = null, logger = console }) {
    this.#engine = engine;
    this.#registry = registry;
    this.#settings = settings;
    this.#serverSettings = serverSettings;
    this.#tuned = tuned;
    this.#logger = logger;
  }

  get trackedId() {
    return this.#trackedId;
  }

  /** True while an idle-unload timer is armed for the tracked model. */
  get armed() {
    return this.#timer !== null;
  }

  async ensure(modelReference) {
    if (!this.#serverSettings.value.justInTimeModelLoading) {
      throw new AppError("No model is loaded", {
        code: "model_not_loaded",
        status: 409,
        why: "ModelDuck needs a loaded model before it can answer.",
        fix: "Load a model in the UI, or enable just-in-time loading in Server settings.",
      });
    }
    const reference = String(modelReference ?? "").trim();
    if (!reference) {
      throw new AppError("A model is required for just-in-time loading", {
        code: "model_required",
        why: "This server has no model loaded and the request did not name one.",
        fix: "Send a model file name or id from GET /v1/models.",
      });
    }
    const entry = this.#registry
      .listPublic()
      .find((model) => sameModel(model, reference));
    if (!entry) {
      throw new AppError("Model not found", {
        code: "model_not_found",
        status: 404,
        why: `${reference} is not in the local model library.`,
        fix: "Call GET /v1/models and use one of the returned ids or file names.",
      });
    }
    const full = this.#registry.findById(entry.id);
    if (!full) throw new AppError("Model not found", { status: 404 });

    const loadedId = this.#engine.loadedId;
    if (loadedId === full.id) {
      this.#touch();
      return full;
    }
    if (loadedId && this.#trackedId !== loadedId) {
      throw new AppError("A different model is loaded", {
        code: "model_already_loaded",
        status: 409,
        why: "Just-in-time loading will not replace a model you loaded manually.",
        fix: "Unload it first, or make the request against that model.",
      });
    }
    if (loadedId && !this.#serverSettings.value.onlyKeepLastJitLoadedModel) {
      throw new AppError("A model is already loaded", {
        code: "model_already_loaded",
        status: 409,
        why: "Only one model can stay loaded and keep-last is disabled.",
        fix: "Unload the current model, or enable only-keep-last in Server settings.",
      });
    }
    if (loadedId) await this.#engine.unload();
    const applied = await this.#tuned?.resolve(full.id);
    await this.#engine.load({
      modelId: full.id,
      ...this.#settings.value,
      ...(applied?.settings ?? {}),
    });
    this.#trackedId = full.id;
    this.#touch();
    this.#logger.info?.(`[modelduck] JIT loaded ${full.fileName}`);
    return full;
  }

  touch() {
    this.#touch();
  }

  clear() {
    this.#trackedId = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  dispose() {
    this.clear();
  }

  #touch() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#serverSettings.value.autoUnloadUnusedJit || !this.#trackedId) return;
    const ttlMinutes = this.#serverSettings.value.maxIdleTtlMinutes;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#trackedId || this.#engine.loadedId !== this.#trackedId) return;
      if (this.#engine.busy) {
        this.#touch();
        return;
      }
      this.#engine
        .unload()
        .then(() => {
          this.#logger.info?.(`[modelduck] JIT unloaded idle model after ${ttlMinutes} minutes`);
          this.#trackedId = null;
        })
        .catch((error) => this.#logger.warn?.(`[modelduck] JIT idle unload failed: ${error.message}`));
    }, Math.max(1, ttlMinutes) * 60_000);
    this.#timer.unref?.();
  }
}
