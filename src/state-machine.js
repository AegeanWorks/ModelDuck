import { AppError } from "./errors.js";

/**
 * A named, immutable state machine: the one place a subsystem's states and
 * legal transitions are written down. Subsystems used to compare string
 * literals inline, which is how a canceled download could still be marked
 * complete. A machine lets a transition be asserted at the write site and
 * makes the vocabulary readable by people and agents (`machineCatalog()`).
 */
export function defineMachine(name, { initial, states, transitions, terminal = [] }) {
  const known = new Set(states);
  if (!known.has(initial)) throw new Error(`${name}: unknown initial state ${initial}`);
  const table = new Map();
  for (const [from, targets] of Object.entries(transitions)) {
    if (!known.has(from)) throw new Error(`${name}: unknown source state ${from}`);
    for (const to of targets) {
      if (!known.has(to)) throw new Error(`${name}: unknown target state ${to}`);
    }
    table.set(from, new Set(targets));
  }
  for (const state of states) if (!table.has(state)) table.set(state, new Set());
  return Object.freeze({
    name,
    initial,
    states: Object.freeze([...states]),
    terminal: Object.freeze([...terminal]),
    can: (from, to) => table.get(from)?.has(to) ?? false,
    assert(from, to) {
      if (!table.get(from)?.has(to)) {
        throw new AppError(`Illegal ${name} transition: ${from} -> ${to}`, {
          code: "invalid_state_transition",
          why: `The ${name} machine does not allow ${from} -> ${to}.`,
          fix: "This is an app bug; report the action that led to it.",
        });
      }
    },
    next(from, to) {
      this.assert(from, to);
      return to;
    },
    toJSON() {
      return {
        name,
        initial,
        states: [...states],
        terminal: [...terminal],
        transitions: Object.fromEntries(
          [...states].map((from) => [from, [...known].filter((to) => table.get(from)?.has(to))]),
        ),
      };
    },
  });
}

/** Model lifecycle: the `phase` the UI and API report. */
export const ENGINE_MACHINE = defineMachine("engine", {
  initial: "idle",
  states: ["idle", "loading", "ready", "error", "unloading"],
  terminal: [],
  transitions: {
    idle: ["idle", "loading", "unloading"],
    loading: ["ready", "error", "unloading", "idle"],
    ready: ["unloading", "error", "idle"],
    error: ["loading", "unloading", "idle", "error"],
    unloading: ["idle", "error", "loading"],
  },
});

/** One download job, from the catalog request to a promoted file. */
export const DOWNLOAD_MACHINE = defineMachine("download", {
  initial: "queued",
  states: ["queued", "downloading", "complete", "canceled", "error"],
  terminal: ["complete", "canceled", "error"],
  transitions: {
    queued: ["downloading", "complete", "canceled", "error"],
    downloading: ["complete", "canceled", "error"],
    complete: [],
    canceled: [],
    error: [],
  },
});

/** One benchmark child process. */
export const BENCHMARK_MACHINE = defineMachine("benchmark", {
  initial: "running",
  states: ["running", "complete", "cancelled", "failed"],
  terminal: ["complete", "cancelled", "failed"],
  transitions: {
    running: ["complete", "cancelled", "failed"],
    complete: [],
    cancelled: [],
    failed: [],
  },
});

export const MACHINES = Object.freeze({
  engine: ENGINE_MACHINE,
  download: DOWNLOAD_MACHINE,
  benchmark: BENCHMARK_MACHINE,
});

/** The vocabulary an agent (or the UI) can read without reading the source. */
export function machineCatalog() {
  return Object.fromEntries(Object.entries(MACHINES).map(([key, machine]) => [key, machine.toJSON()]));
}

/** Move a record's status only when the machine allows it; returns whether it moved. */
export function moveTo(record, machine, status, { field = "status" } = {}) {
  if (!machine.can(record[field], status)) return false;
  record[field] = status;
  return true;
}
