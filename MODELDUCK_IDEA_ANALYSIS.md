# ModelDuck Idea Analysis — 2026-11-04 (251 ideas, excl. Superseded/Blocked)

Scope: target=modelduck, status NOT IN (Superseded, Blocked). Source: `.idea-catcher/ideas.json`.
Verified against: `projects/modelduck/src/` (30 modules), `tests/` (52 files), `benchmarks/*.mjs`, `public/app.js`, `package.json` (Node 20 ESM, node-llama-cpp 3.22.2).

Totals: Deferred 106, Proposed 65, Approved 42, Rejected 22, Integrated 11, Integrating 5 = 251.

## A. Integrating (5) — land/verify, all implement-now except 1047
- IDEA-853 Multi-part resumable download + stall recovery — in tree (downloader.js:155-305). LAND.
- IDEA-862 Gallery w/ mirrors+OCI — hash half in tree, mirrors half open. LAND hash, mirrors next-wave.
- IDEA-882 Process-unique incompletes + atomic promotion — in tree. LAND.
- IDEA-903 Quant-aware memory-fit preflight — refuse-75% + largestSafeContext shipped, RSS calibration → IDEA-1065. LAND.
- IDEA-1047 Retention budget archive-before-evict — no archive|retention|evict in src; verify location (ChatDuck split). NEXT-WAVE.

## B. Integrated (11) — closed, no action
857, 858, 967, 1037, 1054, 1061, 1062, 1063, 1261, 1639, 1641 — all confirmed in tree.

## C. Approved (42) — verdicts
Implement-now: 1200 (template-exact accounting, silent guard-disable bug), 1163 (grammar cache keying), 1080+1085+1264 as one OpenAI-contract package (stop + finish-reason + param refusal), 1067+1194+1195 as one receipt package (install/artifact/resume identity), 1070 (symlink boundary, real empty-library bug), 1097 (schema-fenced settings), 1160 (reply-budget clamp), 1162 (schema preflight), 1197 (SSE backpressure), 1064+1065 (quant ladder + RSS calibration).
Next-wave: 1071, 1072 (after 1070), 1073, 1077, 1078+1193, 1079, 1084, 1093+1228, 1095+1158 (with 1094), 1164, 1198-receipt-half, 1232, 1229, 1265 (with 1161), 1323, 1161.
Hold: 1074 (ChatDuck owns chat SSE), 1076, 1082, 1087, 1098 (needs design), 1192 (blocked on tool calls 942/1041), 1094 trio part — 1094 itself is implement-now (cancelable load).

## D. Proposed (65) — verdicts
Implement-now (Low cost): 1637 (GGUF preflight+estimate glue), 1520 (canonical sampler chain, subsumes 1380/1523), 1617 (Q8_0 lossless ref gate), 1504 (code-needle chain scoring), 1627 (determinism lockdown batch-1+triple-run), 1381 (dir-fsync+range checks), 1618 (Q4_K_M drift disclosure docs), 1623 (fixed-bytes+Q5 disclosure), 1675 (per-model template registry), 1580 (fixed-budget quotas); near-tie: 1496, 1621, 1644, 1676.
Next-wave: 1326, 1328, 1345, 1460, 1393, 1447, 1448, 1503+1543, 1506, 1376, 1535, 1378, 1522, 1524, 1533, 1544, 1555, 1620, 1622+1624, 1626, 1628+1629, 1638, 1640, 1642, 1643, 1677.
Hold: 1336, 1450, 1505, 1374, 1375, 1377 (do 1520 first), 1379 (prefer 1522), 1534, 1552, 1616, 1630, 1645, 1712 (conditional on GGUF+CPU proof).
Reject: 1475 (→crucible), 1449 (dup 1345), 1523 (dup 1380/1520), 1578/1592/1662 (wrong target).

## E. Deferred first half (53) — only 5 unpark
Unpark-now: 1024 (graceful drain, lock half landed), 1051 (pairing QR, unblocked by 1054), 1052 (device registry), 1053 (per-install TLS), 1055 (handoff, after 1051/52). Rest keep-parked; reject-as-ModelDuck (ChatDuck-side or no-gap): 1066, 1068, 1075, 1081, 1083, 1086, 1092, 1165.

## F. Deferred second half (53) — 5 unpark
Unpark-now: 859 (per-request response_format), 997 (thinking pipeline), 995 (HF URI resolver), 954 (KV-budget contract), 855 (full provenance introspection).
Reject-here: 1166, 1167, 1196, 1199, 1226, 1227 (ChatDuck-side), 924 (covered by ADR-018+keys). Rest keep-parked (incl. 860/861/871 gated on safety design; 904/905/940/941 runtime-blocked).

## G. Rejected (22) — all still valid, none to reconsider
942, 1000, 1015, 1018, 1088, 1089, 1090, 1091, 1100, 1101, 1099, 1291-1294, 1319-1322, 1595, 1619, 1678. Only trigger: 942/1015 if tool calling (860) ever lands.

## Recommended Wave 1 (no design risk, mostly Low effort)
1. Correctness: 1200, 1163, 1381, 1627.
2. OpenAI contract package: 1080+1085+1264+859.
3. Provenance package: 1067+1194+1195+855.
4. Settings/library: 1070, 1097, 1160, 1162, 1675.
5. Streaming/load: 1197, 1094 (+1095/1158 trio next), 1637+1064+1065+954 (memory-fit honesty).
6. Bench/docs honesty: 1617, 1504, 1580, 1618, 1623 (+1496, 1621, 1644, 1676 as cheap batch mates).
7. Land Integrating: 853, 862-hash, 882, 903.
Then: 995 (HF resolver) + 997 (thinking) + 1051→1052→1053→1055 LAN chain + 1024 drain as Wave 2 (need auth/UX decisions).

Full per-idea one-by-one evidence is in the five audit results (Approved, Proposed, Deferred-A, Deferred-B, Rejected batches) returned 2026-11-04.
