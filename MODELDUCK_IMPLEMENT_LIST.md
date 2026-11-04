# ModelDuck Implement List — 2026-11-04
Source: 107 Approved+Proposed verified this session (all deep-checked except 13 target-checked KEEP, 3 stale wrong-target, 2 duplicate, 1 deep-checked+stale). Registry valid.

## Wave 1 — implement now (Low risk, mostly Low effort)
### A. Correctness (4)
- IDEA-1200 Template-exact accounting loud failure (High/Low) — engine.js:1010-1017 returns 0 disabling strict guard
- IDEA-1163 Model-keyed grammar cache (Med/Low) — engine.js:98 single slot, no model key, never cleared
- IDEA-1381 Downloader fsync discipline (Med/Low) — downloader.js:275 raw rename, fs-atomic best-effort only
- IDEA-1627 Determinism lockdown batch-1 + triple-run (Med-High/Low) — matrix.mjs:23 batch 512, no gate

### B. OpenAI contract package (4 as one)
- IDEA-1080 Stop-sequence gate (High/Med) — openai.js:79-102 ignores stop
- IDEA-1085 Typed finish taxonomy (Med/Low) — openai.js:115-117 length|stop only
- IDEA-1264 Parameter contract refusal (Med-High/Low) — silently ignores logit_bias etc
- IDEA-0859 (Deferred unpark) per-request response_format — reuses #grammarFor

### C. Provenance package (4 as one)
- IDEA-1067 Install receipt (Med-High/Low) — downloader.js:275-279 no receipt
- IDEA-1194 Artifact receipt digest+quant+backend+runtime (Med-High/Med)
- IDEA-1195 Partial resume identity (Med-High/Med) — size-only resume
- IDEA-0855 (Deferred unpark) full provenance introspection

### D. Settings/library (5)
- IDEA-1070 Symlink boundary (Med-High/Low) — registry.js:97-99 isFile drops symlinks
- IDEA-1097 Schema-fenced settings (Med/Low) — settings.js:19-30 version never read
- IDEA-1160 Reply-budget clamp (Med-High/Low)
- IDEA-1162 Schema preflight 400/422 (Med-High/Low)
- IDEA-1675 Per-model template registry (Med/Low)

### E. Streaming/load + memory honesty (7)
- IDEA-1197 Batched SSE backpressure (High/Low) — http.js:137-143 ignores write return
- IDEA-1094 Cancelable load (High/Med) + IDEA-1095 teardown receipt + IDEA-1158 phase machine (trio)
- IDEA-1637 GGUF preflight+estimate glue (Med-High/Low)
- IDEA-1064 Quant ladder (Med-High/Med) + IDEA-1065 RSS calibration (High/Med) + IDEA-0954 KV contract

### F. Bench/docs honesty (8 cheap)
- IDEA-1617 Q8_0 lossless ref gate (High/Low)
- IDEA-1504 Code-needle chain scoring (High/Low)
- IDEA-1580 Fixed-budget quotas (Med-High/Low)
- IDEA-1618 Q4_K_M drift disclosure, IDEA-1623 fixed-bytes Q5 disclosure, IDEA-1496 temp-as-cost preset, IDEA-1621 imatrix disclosure, IDEA-1644 threat-model doc, IDEA-1676 reasoning-off default

### G. Land Integrating (4)
- IDEA-0853 multi-part resume, IDEA-0862 hash half, IDEA-0882 atomic promotion, IDEA-0903 memory-fit preflight

## Wave 2 — needs decision (auth/UX/scope)
- IDEA-0995 HF URI resolver (biggest user unlock, needs guardrails)
- IDEA-0997 Thinking pipeline (unlocks 1266)
- IDEA-1051→1052→1053→1055 LAN pairing chain (unblocked by 1054) + IDEA-1024 graceful drain
- IDEA-1520 canonical sampler chain (subsumes 1380/1523), IDEA-1522 Modelfile, IDEA-1524 probe-measure-pin

## Explicitly NOT implementing
- Duplicate: 1449 (=1345), 1523 (=1380/1520)
- Stale/wrong-target (re-file to crucible/ChatDuck/neurocore): 1475, 1578, 1592, 1662
- ChatDuck-side (reject here): 1166, 1167, 1196, 1199, 1226, 1227 + Deferred-A rejects 1066, 1068, 1075, 1081, 1083, 1086, 1092, 1165
- Hold (needs design/runtime): 1074, 1076, 1082, 1087, 1098, 1192, 860/861/871, 904/905/940/941

Total tagged this session: 32 ops (4 Approved upgrades, 9 Proposed-A, 19 Proposed-B incl. 3 stale). Registry valid.
