/**
 * Curated single-file GGUF models. Every entry is pinned to a repository and
 * exact byte size, so a slow or truncated download can be detected before it
 * ever reaches the model list.
 *
 * Honesty notes (bench Wave 3, docs-only):
 * - Q4_K_M is lossy: expect small quality drift versus the Q8_0 ceiling in
 *   the same family; a close score is a tie, not a win (IDEA-1618).
 * - No entry here uses imatrix calibration. Q4_K_M is the generic mix
 *   without importance-matrix tuning; no Q2/imatrix entry is cataloged, and
 *   a Q2 without imatrix would drift far more than these Q4 entries
 *   (IDEA-1621).
 * - The Q5 entry costs fixed extra weight bytes over its Q4 sibling
 *   (522,186,592 vs 491,400,032: ~30 MB), not a ratio; memory math is always
 *   fixed bytes — weights plus KV plus the runtime reserve (IDEA-1623).
 */
export const QUANT_HONESTY_NOTES = Object.freeze({
  q4Drift:
    "Q4_K_M is lossy: expect small quality drift versus the Q8_0 ceiling in this family; a close score is a tie, not a win.",
  imatrix:
    "No entry here uses imatrix calibration: Q4_K_M is the generic mix without importance-matrix tuning, and no Q2/imatrix entry is cataloged — a Q2 without imatrix would drift far more than these Q4 entries.",
  q5Overhead:
    "Q5_K_M costs ~30 MB more weights than the Q4 sibling in this family (fixed bytes: 522,186,592 vs 491,400,032) for a small fidelity gain.",
});

export const MODEL_CATALOG = [
  {
    id: "smollm2-135m-instruct-q4",
    name: "SmolLM2 135M Instruct",
    file: "SmolLM2-135M-Instruct-Q4_K_M.gguf",
    repo: "bartowski/SmolLM2-135M-Instruct-GGUF",
    size: 105454432,
    sha256: "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d",
    params: "135M",
    quant: "Q4_K_M",
    context: 8192,
    license: "Apache-2.0",
    tagline: "Tiny smoke-test model. Loads in seconds, useful for checking the app.",
    note: `${QUANT_HONESTY_NOTES.q4Drift} ${QUANT_HONESTY_NOTES.imatrix}`,
    tags: ["test", "tiny"],
    recommended: false,
  },
  {
    id: "qwen2.5-0.5b-instruct-q4",
    name: "Qwen2.5 0.5B Instruct",
    file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    size: 491400032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    params: "0.5B",
    quant: "Q4_K_M",
    context: 32768,
    license: "Apache-2.0",
    tagline: "Fast first chat model. Good for quick questions on any laptop.",
    note: `${QUANT_HONESTY_NOTES.q4Drift} ${QUANT_HONESTY_NOTES.imatrix}`,
    tags: ["starter", "fast"],
    recommended: true,
  },
  {
    id: "qwen2.5-1.5b-instruct-q4",
    name: "Qwen2.5 1.5B Instruct",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    size: 1117320736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    params: "1.5B",
    quant: "Q4_K_M",
    context: 32768,
    license: "Apache-2.0",
    tagline: "Best all-round balance for a 16 GB CPU machine. Recommended.",
    note: `${QUANT_HONESTY_NOTES.q4Drift} ${QUANT_HONESTY_NOTES.imatrix}`,
    tags: ["starter", "general", "recommended"],
    recommended: true,
  },
  {
    id: "qwen2.5-0.5b-instruct-q5",
    name: "Qwen2.5 0.5B Instruct · Q5_K_M",
    file: "qwen2.5-0.5b-instruct-q5_k_m.gguf",
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    size: 522186592,
    sha256: "041474553fcabfc2a2d67903f9d2c2e50bd92528e670da4f33b5d0ce6e59fd55",
    params: "0.5B",
    quant: "Q5_K_M",
    context: 32768,
    license: "Apache-2.0",
    tagline: "Higher-fidelity 0.5B weights for quantization comparisons.",
    note: QUANT_HONESTY_NOTES.q5Overhead,
    tags: ["quantized", "general"],
    recommended: false,
  },
  {
    id: "qwen2.5-0.5b-instruct-q8",
    name: "Qwen2.5 0.5B Instruct · Q8_0",
    file: "qwen2.5-0.5b-instruct-q8_0.gguf",
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    size: 675710816,
    sha256: "ca59ca7f13d0e15a8cfa77bd17e65d24f6844b554a7b6c12e07a5f89ff76844e",
    params: "0.5B",
    quant: "Q8_0",
    context: 32768,
    license: "Apache-2.0",
    tagline: "Near-lossless 0.5B weights; the quality ceiling for this family.",
    note: "Quality ceiling for this family: bench comparisons judge smaller quants against these weights.",
    tags: ["quantized", "general"],
    recommended: false,
  },
  {
    id: "qwen2.5-coder-1.5b-instruct-q4",
    name: "Qwen2.5 Coder 1.5B Instruct",
    file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    size: 1117320768,
    sha256: "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
    params: "1.5B",
    quant: "Q4_K_M",
    context: 32768,
    license: "Apache-2.0",
    tagline: "A small coding companion for snippets, explanations, and refactors.",
    note: `${QUANT_HONESTY_NOTES.q4Drift} ${QUANT_HONESTY_NOTES.imatrix}`,
    tags: ["code"],
    recommended: false,
  },
  {
    id: "llama-3.2-3b-instruct-q4",
    name: "Llama 3.2 3B Instruct",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    size: 2019377696,
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
    params: "3B",
    quant: "Q4_K_M",
    context: 131072,
    license: "Llama 3.2 Community License",
    tagline: "A different model family with about 3.2 GB of runtime memory.",
    note: `${QUANT_HONESTY_NOTES.q4Drift} ${QUANT_HONESTY_NOTES.imatrix}`,
    tags: ["general", "smarter", "heavy"],
    recommended: false,
  },
  {
    id: "phi-3.5-mini-instruct-q4",
    name: "Phi-3.5 Mini Instruct",
    file: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
    repo: "bartowski/Phi-3.5-mini-instruct-GGUF",
    size: 2393232672,
    sha256: "e4165e3a71af97f1b4820da61079826d8752a2088e313af0c7d346796c38eff5",
    params: "3.8B",
    quant: "Q4_K_M",
    context: 131072,
    license: "MIT",
    tagline: "Strong reasoning near the 4 GB memory mark. Desktop CPU recommended.",
    note: `${QUANT_HONESTY_NOTES.q4Drift} ${QUANT_HONESTY_NOTES.imatrix}`,
    tags: ["reasoning", "heavy"],
    recommended: false,
  },
  {
    id: "mistral-7b-instruct-v0.3-q4",
    name: "Mistral 7B Instruct v0.3",
    file: "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
    repo: "bartowski/Mistral-7B-Instruct-v0.3-GGUF",
    size: 4372812000,
    sha256: "1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6",
    params: "7B",
    quant: "Q4_K_M",
    context: 32768,
    license: "Apache-2.0",
    tagline: "Heavyweight for CPU chat. Use only with 10 GB+ of free RAM.",
    note: `${QUANT_HONESTY_NOTES.q4Drift} ${QUANT_HONESTY_NOTES.imatrix}`,
    tags: ["heavy"],
    recommended: false,
  },
];

const CATALOG_BY_ID = new Map(MODEL_CATALOG.map((model) => [model.id, Object.freeze(model)]));

export function getCatalogModel(id) {
  return CATALOG_BY_ID.get(id) ?? null;
}

export function downloadUrl(model) {
  // hygiene: allow curated model download source, chosen by the user
  return `https://huggingface.co/${model.repo}/resolve/main/${encodeURIComponent(model.file)}`;
}

export function modelHomepage(model) {
  // hygiene: allow curated model homepage shown in the catalogue
  return `https://huggingface.co/${model.repo}`;
}

export function publicCatalog() {
  return MODEL_CATALOG.map((model) => ({
    ...model,
    homepage: modelHomepage(model),
  }));
}
