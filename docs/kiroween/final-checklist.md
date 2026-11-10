# Kiroween 2026 Final Submission Checklist — ModelDuck

Use this to verify eligibility before hitting Submit on Devpost.

---

## 1. GitHub repository

- [x] Repository exists and is public: https://github.com/AegeanWorks/ModelDuck
- [ ] All hackathon work is pushed to `origin/master`
- [ ] `.kiro/` directory is present and tracked (not in `.gitignore`)
- [ ] `JUDGES.md` is present at the repo root
- [ ] `docs/kiroween/` directory is present with all four files

## 2. Kiro workspace

- [x] `.kiro/steering/project-overview.md` created
- [x] `.kiro/steering/coding-standards.md` created
- [x] `.kiro/steering/kiro-agent-mode.md` created
- [x] `.kiro/specs/kiro-agent-mode-integration.md` created
- [ ] `.kiro/` committed and pushed to GitHub

## 3. Demo video

- [x] YouTube video: https://www.youtube.com/watch?v=3MX8_ULrQ_s
- [x] Video is publicly accessible
- [x] Devpost submission already created and video attached: https://devpost.com/software/necro-software-resurrection-engine

## 4. Test build (Windows)

- [x] `ModelDuck-Windows-x64.zip` created (~118 MB compressed, ~377 MB uncompressed)
- [x] Zip contains: `src/`, `public/`, `benchmarks/`, `tests/`, `scripts/`,
      `docs/`, `assets/`, `package.json`, `package-lock.json`, `start.bat`,
      `README.md`, `JUDGES.md`, `LICENSE`, `LICENSES/`, `COMMERCIAL.md`,
      `REUSE.toml`, `benchmarks/NOTICE-benchmarks.md`
- [x] Zip does NOT contain: `*.gguf` user model weights, `server-settings.json`,
      `chats.json`, `settings.json`, `benchmarks/results/`,
      `benchmarks/history.sqlite`, `.git/`, `.aikit/`
      (node-llama-cpp contains vocab `.gguf` test files — these are part of the package, not user weights)
- [x] SHA-256: `5766974A458D949DD8324D137AB7C16474C21F14B297307CA90A49BEC39CB254`
- [x] Checksum file: `ModelDuck-Windows-x64.zip.sha256` (on Desktop alongside zip)
- [x] Build manifest: `docs/kiroween/build-manifest.md`
- [ ] Upload zip to shareable location (Google Drive, GitHub Release, Dropbox, etc.)
- [ ] Shareable link added to Devpost as "Try it out" URL

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
| Upload zip and add "Try it out" link | You | Upload `ModelDuck-Windows-x64.zip` to Google Drive / GitHub Release / Dropbox, then edit the Devpost submission to add the link |
| Push to GitHub | You | Commit all staged files, then `git push origin master` |
| Kiro + pre-existing work fields on Devpost | You | Paste from `kiro-usage.md` and `preexisting-work-disclosure.md` into any remaining Devpost fields |
