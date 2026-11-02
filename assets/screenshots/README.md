# ModelDuck screenshot gallery

Twenty-seven stills for the ModelDuck video, captured from the real control panel at 1440×900 and 390×844. `23-social-preview.png` is the 1280×640 social card.

The demo states are injected by `scripts/capture-screenshots.mjs`; they are illustrative examples, not benchmark claims. Regenerate the full set with:

```bash
npm run ui:shots
```

## Suggested 3-minute storyboard

| Time | Shot | Use |
|---|---|---|
| 0:00–0:08 | `01-overview.png` | Cold open: “Serve the model. Tune the code.” |
| 0:08–0:16 | `02-models-installed.png` | Two local GGUF models, no cloud account. |
| 0:16–0:24 | `03-models-discover.png` | Catalog models sized for this PC. |
| 0:24–0:34 | `11-bench-suite.png` | The three-task coding suite: 265 questions. |
| 0:34–0:44 | `11b-bench-suite-long-context.png` | Comprehension and long-context coverage. |
| 0:44–0:55 | `04-bench-tune-idle.png` | Task scope, quick/full preflight and measured pace. |
| 0:55–1:05 | `04b-bench-tune-controls.png` | Quick pass, pause, guard and background controls. |
| 1:05–1:15 | `05-bench-tune-help.png` | How the stages, rungs and held-back check work. |
| 1:15–1:27 | `16-bench-tune-running.png` | Live guarded quick pass with a provisional preset. |
| 1:27–1:39 | `17-bench-tune-queue.png` | Move a waiting model, pause, stop the whole queue. |
| 1:39–1:51 | `17b-bench-live.png` | The setting being tried, candidates and decisions. |
| 1:51–2:01 | `06-bench-models.png` | Tuned profile table: device, stages, right answers. |
| 2:01–2:10 | `07-bench-model-details.png` | One profile’s measured load shape and task settings. |
| 2:10–2:20 | `08-bench-runs.png` | Every run, answer count and pace. |
| 2:20–2:31 | `09-bench-run-detail.png` | One run in full: stats, tasks and decisions. |
| 2:31–2:38 | `10-bench-tune-settings.png` | The values each setting is tried at. |
| 2:38–2:47 | `12-bench-gate.png` | The quality gate and recent history. |
| 2:47–2:54 | `13-settings.png` | Runtime, sampling and prompt settings. |
| 2:54–2:59 | `14-light-overview.png` | The light theme. |
| 2:59–3:05 | `15-server.png` | Local API, port, LAN and authentication. |
| 3:05–3:12 | `18-mobile-overview.png` | The workbench at 390 px. |
| 3:12–3:18 | `19-mobile-tune.png` | Full-screen tuning sheet. |
| 3:18–3:24 | `19b-mobile-tune-controls.png` | Preflight and Quick pass on mobile. |
| 3:24–3:30 | `20-mobile-models.png` | Models remain usable on mobile. |
| 3:30–3:36 | `21-mobile-settings.png` | Settings scroll cleanly. |
| 3:36–3:42 | `22-mobile-suite.png` | Suite readability on mobile. |
| 3:42–3:50 | `23-social-preview.png` | Outro and social card. |

The timings are deliberately generous; trim to taste or hold individual shots longer for a slower narration. `manifest.json` carries the same titles and captions in machine-readable form.
