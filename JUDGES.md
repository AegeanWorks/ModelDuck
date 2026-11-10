# ModelDuck — Judge Installation and Testing Guide

Thank you for evaluating ModelDuck for Kiroween 2026.

---

## Prerequisites

| Requirement | Minimum version | Notes |
|---|---|---|
| Windows | 10 or 11 (64-bit) | Tested on Windows 11 |
| Node.js | 20.0.0 | Download from https://nodejs.org (LTS recommended) |
| RAM | 8 GB | 2 GB free at runtime for the smallest model |
| Browser | Edge 115+ or Chrome 115+ | App window opens automatically |
| Internet | Broadband | Only needed for the first model download |

A GPU is optional. CPU-only inference works out of the box.

---

## Installation (from the zip)

1. Extract `ModelDuck-Windows-x64.zip` to any folder (e.g. `C:\ModelDuck`).
2. Double-click **`start.bat`**.
   - On first run this installs `node-llama-cpp` (the only npm dependency,
     ~20 MB prebuilt binary — no compile step). This may take 30–60 seconds.
   - On subsequent runs it starts immediately.
3. ModelDuck opens at **http://127.0.0.1:4141** in a browser or app window.
   Closing the window does **not** stop the server; press **Ctrl+C** in the
   terminal to quit.

> If the zip already includes `node_modules\node-llama-cpp`, step 2 skips the
> install entirely.

---

## Downloading a model

1. Open the **Models** tab.
2. Click **Discover** (or **Catalog**).
3. Choose a model — recommended for a quick test:

   | Model | Size | RAM needed |
   |---|---|---|
   | **Qwen2.5 0.5B Instruct Q4** | 469 MB | ~0.9 GB |
   | Qwen2.5 1.5B Instruct Q4 | 1.1 GB | ~1.8 GB |

4. Click **Download**. Progress appears in the Models tab.
5. When the download finishes, click **Install → Load**.

ModelDuck checks the GGUF header with a SHA-256 receipt before loading.

---

## Loading and chatting

1. After loading, the **Server** tab shows `Loaded: <model name>`.
2. The status bar at the top shows the active model.
3. To chat, open **ChatDuck** (a separate client):
   - GitHub: https://github.com/AegeanWorks/Chatduck
   - Or use any OpenAI-compatible client pointed at `http://127.0.0.1:4141/v1`.
4. Quick API test (PowerShell):

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:4141/v1/chat/completions" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"model":"modelduck","messages":[{"role":"user","content":"Say quack in one word."}],"stream":false}'
```

---

## Running the Bench & Tune

The tuner finds optimal settings for a loaded model on your machine.

1. Load a model (see above).
2. Open the **Bench & Tune** tab.
3. Click **Tune → Run** (or **Quick pass** for a faster sweep).
4. The tuner measures device (CPU vs GPU), context size, KV cache, speed
   settings, and sampling parameters in order. Each step is saved so you can
   stop and resume.
5. When finished, **Recommended for this PC** shows ranked configurations.
6. Click a recommendation card's **Fill settings** to apply it to the
   currently loaded model.

The benchmark tab (**Bench**) shows the last stored quality and speed scores.
Scores are split between private (ModelDuck-authored) and public benchmark
items (GSM8K, HumanEval, MBPP — see `benchmarks/NOTICE-benchmarks.md`).

---

## Running the full test suite (optional)

```powershell
cd C:\ModelDuck
npm test
```

This runs 80+ hermetic unit and integration tests. No model files required.
Expected output: all tests pass. Takes ~30 seconds on a modern CPU.

---

## Common issues

| Symptom | Fix |
|---|---|
| "ModelDuck needs Node.js 20 or newer" | Install Node.js from https://nodejs.org |
| Port 4141 already in use | Run `node src\main.js --port 4142` |
| "ModelDuck is already running" | A prior run left a lock. Close it or use `--home <new-folder>` |
| Download stalls | ModelDuck auto-retries after 60 s; click Download again to resume |
| Model listed as "Unreadable" | The GGUF file is corrupted; re-download it |
| App window doesn't open | Browse to http://127.0.0.1:4141 manually |

---

## Repository and resources

- GitHub: https://github.com/AegeanWorks/ModelDuck
- README: full API reference, GPU setup, OpenAI SDK integration
- Threat model: `docs/THREAT-MODEL.md`
- State machine inventory: `docs/state-machines.md`
