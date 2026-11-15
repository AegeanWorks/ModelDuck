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
- [x] **Rebuilt release**: https://github.com/AegeanWorks/ModelDuck/releases/tag/v0.1.1-kiroween (2026-11-15, commit `9382995`, MIT, SHA-256 `C8FDF28D…624ECD`)
- [ ] Add the v0.1.1 release URL to Devpost "Try it out": `https://github.com/AegeanWorks/ModelDuck/releases/tag/v0.1.1-kiroween`

## 5. License

- [x] **Licensed under MIT** — OSI-approved open-source license
- [x] `LICENSE` updated to MIT text
- [x] `REUSE.toml` updated (`SPDX-License-Identifier = "MIT"`)
- [x] `LICENSES/MIT.txt` added; `LICENSES/LicenseRef-AL-1.1.txt` removed
- [x] `README.md` badge updated to MIT
- [x] `package.json` `"license"` field updated to `"MIT"`
- [x] **The v0.1.1-kiroween zip is MIT** (checked 2026-11-15 on the built zip: `LICENSE` and `package.json` say MIT, no `COMMERCIAL.md`, no AL-1.1 file; the README License section and `.kiro` steering say MIT too). The older finding, kept for the record:
- [x] ~~The released zip is not MIT.~~ Checked 2026-11-15: `ModelDuck-Windows-x64.zip` of `v0.1.0-kiroween` was built from the tree before the license commit, so its `LICENSE` is Aegean License 1.1, its `package.json` says `SEE LICENSE IN LICENSE`, and it has `LICENSES/LicenseRef-AL-1.1.txt` but no `MIT.txt` and no `.kiro/`. The repository and the tag are MIT. Rebuild the zip from the tag (or `master`) to make the download match.

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
- [x] **Social Blitz Prize**: https://x.com/AegeanWorks/status/2120257703058763937
  → Add this URL to the Devpost submission's Social Blitz Prize field

## 8. Pre-submission sanity checks

v0.1.1-kiroween, checked 2026-11-15 on the built zip before upload (Windows 11, Node 26.9.0, a temp home): SHA-256 matches its `.sha256`; `npm test` on its contents 877 tests, 876 pass, 1 skipped, 0 fail; the app starts and serves the page (no ChatDuck); recommendations rank Qwen2.5 Coder 1.5B first at 54.2%; `src/mcp-server.js` answers `initialize`. `start.bat` on a fresh machine is still unchecked.

v0.1.0-kiroween, checked 2026-11-15 on the downloaded release zip (Windows 11, Node 26.9.0, a temp home):

- [x] `npm test` passes on the zip contents: 609 tests, 608 pass, 1 skipped, 0 fail
- [ ] `start.bat` launches without error on a fresh Windows machine (or VM): not checked; the app was started with `node src/main.js`, the command `start.bat` runs, on a machine that already has Node
- [x] The app opens: the page answers 200 (checked on port 4196)
- [x] Models and catalog endpoints answer (the API behind the Models tab and Discover; the tab itself was not clicked)
- [x] SHA-256 of the zip matches the `.sha256` file (`5766974A…CB254`)

---

## Remaining blockers

| Item | Owner | Note |
|---|---|---|
| Add "Try it out" URL on Devpost | You | https://github.com/AegeanWorks/ModelDuck/releases/tag/v0.1.0-kiroween |
| Paste Kiro explanation on Devpost | You | Copy from `docs/kiroween/kiro-usage.md` |
| Paste pre-existing work on Devpost | You | Copy from `docs/kiroween/preexisting-work-disclosure.md` |
