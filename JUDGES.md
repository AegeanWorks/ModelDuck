# ModelDuck — Judge Installation and Testing Guide

Thank you for evaluating ModelDuck for Kiroween 2026.

---

## Prerequisites

| Requirement | Minimum version | Notes |
|---|---|---|
| Windows | 10 or 11 (64-bit) | Tested on Windows 11 |
| Node.js | 20.0.0 | Download from https://nodejs.org (LTS recommended). Verified code (below) needs 25+ |
| RAM | 8 GB | 2 GB free at runtime for the smallest model |
| Browser | Edge 115+ or Chrome 115+ | App window opens automatically |
| Internet | Broadband | Only needed for the first model download |

A GPU is optional. CPU-only inference works out of the box.

---

## The 5-minute path

The point of ModelDuck is time to a good local setup. This path shows all three
speeds: a measured preset in seconds, a time-boxed tune in minutes, and a
multistep evaluation that says how well the model keeps state across steps.

1. **Start it**: double-click `start.bat` (details below). It opens at
   http://127.0.0.1:4141.
2. **Get a small model**: Models → Discover → **Qwen2.5 0.5B Instruct Q4**
   (469 MB) → Download → Install.
3. **Seconds: apply a measured preset.** Bench & Tune → Tune → open
   **Shipped presets** → **Apply** next to `qwen2.5-0.5b-instruct-q4`. The row says
   how it fits your computer before you click. A preset measured on another
   machine applies its sampling and prompt settings only; its GPU and thread
   settings stay at your defaults. Nothing is applied unless you click.
4. **Minutes: a time-boxed tune.** Set **Minutes per model** to `3` and click
   **Quick pass**. The tuner stops when the time is up, keeps the best settings
   it has verified, and marks them provisional. From a terminal the same is
   `npm run tune -- --model qwen2.5-0.5b-instruct-q4 --quick --budget 3`, which ends
   with a `Time …` line saying where the minutes went (generate, load, judge).
5. **Multistep: does it keep state?**
   ```powershell
   npm run bench:multistep -- --model qwen2.5-0.5b-instruct-q4
   ```
   Five 3-step coding chains run as one conversation each; every step changes or
   builds on the model's own earlier code and is checked by running it. The last
   line gives the rate at each step depth. Measured on a Radeon RX 9060 XT
   (Vulkan): Qwen2.5 0.5B scored 50% at step 1 and 16% at step 2, while Qwen2.5
   Coder 1.5B held 82% → 84% → 72%. Each run took about 10 s on that GPU; on a CPU
   expect a minute or two (not measured).
6. **Verified code: retry until the tests pass** (Node 25+, a model loaded). Send a
   prompt and test cases; ModelDuck runs the tests on each answer in the sandbox
   and asks again, in a new conversation, until one passes:
   ```powershell
   $body = '{"prompt":"Write a JavaScript function double(n) that returns n times 2.","tests":{"entry":"double","cases":[{"args":[2],"expect":4},{"args":[-3],"expect":-6}]}}'
   Invoke-RestMethod -Uri "http://127.0.0.1:4141/api/code/verify" -Method Post -ContentType "application/json" -Body $body
   ```
   The reply says whether it passed, on which try, and the code. On the 134 code
   items of the repair bench (`npm run bench:repair`), Qwen2.5 Coder 1.5B solved
   60.4% with one answer and 70.9% with the default 4 tries. Telling the model why
   it failed measured no better than asking again.

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
items (HumanEval and MBPP, translated to JavaScript — see `benchmarks/NOTICE-benchmarks.md`).

---

## Running the full test suite (optional)

```powershell
cd C:\ModelDuck
npm test
```

This runs several hundred hermetic unit and integration tests (about 840 at the
time of writing, so the exact figure moves). No model
files required. Expected output: all tests pass. It takes about 8 to 12 seconds
on a modern CPU; `npm run test:parallel` splits it into shards.

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
