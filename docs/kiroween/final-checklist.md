# Kiroween 2026 Final Submission Checklist — ModelDuck

Use this to verify eligibility before hitting Submit on Devpost.

---

## 1. GitHub repository

- [x] Repository exists and is public: https://github.com/AegeanWorks/ModelDuck
- [x] All hackathon work pushed to `origin/master` (commit `afccd99`)
- [x] `.kiro/` directory is present and tracked
- [x] `JUDGES.md` is present at the repo root
- [x] `docs/kiroween/` directory is present with all files

## 2. Kiro workspace

- [x] `.kiro/steering/project-overview.md` created and pushed
- [x] `.kiro/steering/coding-standards.md` created and pushed
- [x] `.kiro/steering/kiro-agent-mode.md` created and pushed
- [x] `.kiro/specs/kiro-agent-mode-integration.md` created and pushed
- [x] `.kiro/` committed and pushed to GitHub

## 3. Demo video

- [x] YouTube video: https://www.youtube.com/watch?v=3MX8_ULrQ_s
- [x] Video is publicly accessible
- [x] Devpost submission already created and video attached: https://devpost.com/software/necro-software-resurrection-engine

## 4. Test build (Windows)

- [x] `ModelDuck-Windows-x64.zip` created (~118 MB compressed, ~377 MB uncompressed)
- [x] SHA-256: `5766974A458D949DD8324D137AB7C16474C21F14B297307CA90A49BEC39CB254`
- [x] Build manifest: `docs/kiroween/build-manifest.md`
- [x] **GitHub Release created**: https://github.com/AegeanWorks/ModelDuck/releases/tag/v0.1.0-kiroween
  - Zip and `.sha256` checksum file both attached to the release
- [ ] Add release URL to Devpost "Try it out" field: `https://github.com/AegeanWorks/ModelDuck/releases/tag/v0.1.0-kiroween`

## 5. License

- [x] **Licensed under MIT** — OSI-approved open-source license
- [x] `LICENSE` updated to MIT text
- [x] `REUSE.toml` updated (`SPDX-License-Identifier = "MIT"`)
- [x] `LICENSES/MIT.txt` added; `LICENSES/LicenseRef-AL-1.1.txt` removed
- [x] `README.md` badge updated to MIT
- [x] `package.json` `"license"` field updated to `"MIT"`

## 6. Devpost form fields

| Field | Status | Value |
|---|---|---|
| Project name | ✅ Live | ModelDuck: Auto-Tune |
| Tagline | ✅ Live | Benchmark, tune, and serve local AI models with hardware-aware performance optimization |
| Description | ✅ Live | On Devpost |
| Built with | ✅ Live | node.js, javascript, node-llama-cpp, etc. |
| GitHub URL | ✅ Live | https://github.com/AegeanWorks/ModelDuck |
| Demo video URL | ✅ Live | https://www.youtube.com/watch?v=3MX8_ULrQ_s |
| Devpost URL | ✅ Live | https://devpost.com/software/necro-software-resurrection-engine |
| Try it out URL | **Action needed** | Add zip download link once uploaded |
| Category | Confirm on form | Frankenstein |
| Country | Confirm on form | Turkey |
| Kiro technology explanation | **Action needed** | Paste from `kiro-usage.md` if not yet added |
| Pre-existing work | **Action needed** | Paste from `preexisting-work-disclosure.md` if not yet added |

## 7. Bonus prize eligibility (verify before claiming)

- [x] **Open source bonus**: MIT is OSI-approved — eligible to claim.
- [ ] **Best use of AI for security**: ADR-018 (cross-site protection) + ADR-019 (GGUF guard) + threat model could qualify. Describe in submission.
- [ ] **Community favorite**: No action — votes accumulate after submission.

## 8. Pre-submission sanity checks

- [ ] `npm test` passes on the zip contents (no model needed)
- [ ] `start.bat` launches without error on a fresh Windows machine (or VM)
- [ ] The app opens at http://127.0.0.1:4141
- [ ] Models tab loads; Discover is accessible
- [ ] SHA-256 of the zip matches the `.sha256` file

---

## Remaining blockers

| Item | Owner | Note |
|---|---|---|
| Add "Try it out" URL on Devpost | You | https://github.com/AegeanWorks/ModelDuck/releases/tag/v0.1.0-kiroween |
| Paste Kiro explanation on Devpost | You | Copy from `docs/kiroween/kiro-usage.md` |
| Paste pre-existing work on Devpost | You | Copy from `docs/kiroween/preexisting-work-disclosure.md` |
