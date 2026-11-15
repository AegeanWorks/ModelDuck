# License Audit — ModelDuck / Kiroween 2026

**Current license**: MIT  
**Audit status**: Migration from AL-1.1 to MIT completed.

---

## Migration completed

The following files were updated:

| File | Change |
|---|---|
| `LICENSE` | Replaced AL-1.1 full text with MIT License |
| `REUSE.toml` | `SPDX-License-Identifier` changed to `MIT` |
| `LICENSES/LicenseRef-AL-1.1.txt` | Removed |
| `LICENSES/MIT.txt` | Added |
| `README.md` badge | Updated to `license-MIT` |
| `package.json` | `"license"` changed to `"MIT"` |

---

## Third-party notices (unchanged, still required)

These are required by the third-party licenses regardless of ModelDuck's own license:

| Component | License | Required notice |
|---|---|---|
| node-llama-cpp | MIT | `node_modules/node-llama-cpp/LICENSE` |
| GSM8K items | MIT © OpenAI | `benchmarks/NOTICE-benchmarks.md` ✓ |
| MMLU items | MIT © Hendrycks et al. | `benchmarks/NOTICE-benchmarks.md` ✓ |
| HumanEval items (JS) | MIT © OpenAI | `benchmarks/NOTICE-benchmarks.md` ✓ |
| MBPP items (JS) | CC BY 4.0 © Google LLC | `benchmarks/NOTICE-benchmarks.md` ✓ |
| TruthfulQA items | Apache-2.0 © Lin, Hilton, Evans | `benchmarks/NOTICE-benchmarks.md` ✓ |

MIT is compatible with all of the above. No additional NOTICE file is required.

---

## Bonus prize eligibility (updated)

MIT is an OSI-approved open-source license. The **open-source bonus prize** is now claimable.

## Correction (2026-11-15)

The migration above was incomplete. Three files still described the Aegean
licenses after it: the README's License section (AL-1.1 for personal use, ACL-1.0
for commercial use), `COMMERCIAL.md` (the paid commercial tiers) and
`.kiro/steering/project-overview.md`. The README section and the steering line now
say MIT, and `COMMERCIAL.md` is removed; it stays in git history. The
`v0.1.0-kiroween` zip was also built before the migration and ships AL-1.1; the
`v0.1.1-kiroween` zip is built from the corrected tree.
