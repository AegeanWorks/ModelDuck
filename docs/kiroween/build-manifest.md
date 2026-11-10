# ModelDuck Windows Test Build — Manifest

## Zip contents

**File**: `ModelDuck-Windows-x64.zip`  
**SHA-256**: `5766974A458D949DD8324D137AB7C16474C21F14B297307CA90A49BEC39CB254`  
**Compressed size**: ~118 MB  
**Uncompressed size**: ~377 MB

## What's included

```
ModelDuck-Windows-x64/
├── src/                  All server source modules
├── public/               Vanilla JS/CSS control panel
├── benchmarks/           Benchmark suite (without results/ and history.sqlite)
├── tests/                Full test suite (80+ files)
├── scripts/              Screenshot capture, parallel runner, UI smoke check
├── docs/                 Threat model, state machine docs, kiroween/ folder
├── assets/               Logo, social preview, screenshots, demo script
│                         (MP4/WAV binaries excluded — rebuild with ffmpeg)
├── LICENSES/             LicenseRef-AL-1.1.txt
├── node_modules/         Production + devDependencies, with:
│   ├── node-llama-cpp/   The inference binding (CPU prebuilt included)
│   ├── @node-llama-cpp/
│   │   ├── win-x64/      CPU prebuilt runtime  (~31 MB)
│   │   └── win-x64-vulkan/ Vulkan GPU prebuilt (~71 MB)
│   │   (CUDA prebuilts excluded to reduce size)
│   └── ... (all other dependencies)
├── package.json
├── package-lock.json
├── start.bat             Double-click to run on Windows
├── README.md
├── JUDGES.md
├── LICENSE               Aegean License 1.1
├── COMMERCIAL.md
└── REUSE.toml
```

## What's excluded

| Item | Reason |
|---|---|
| `*.gguf` model files | Not bundled (user downloads via app) |
| `benchmarks/results/` | Local run data |
| `benchmarks/history.sqlite` | Local run database |
| `assets/*.mp4`, `assets/*.wav` | Large generated binaries; script tracked |
| `@node-llama-cpp/win-x64-cuda` | CUDA prebuilt (~174 MB) — omitted for size |
| `@node-llama-cpp/win-x64-cuda-ext` | CUDA-ext prebuilt (~370 MB) — omitted |
| `@node-llama-cpp/win-arm64` | ARM64 prebuilt — not needed for x64 |
| `.git/`, `.aikit/` | Version control / AIKit metadata |
| `server-settings.json`, `chats.json`, `settings.json` | Personal runtime data |

## GPU note

The zip includes the Vulkan prebuilt (`@node-llama-cpp/win-x64-vulkan`), which
supports AMD and Intel integrated GPUs. For NVIDIA CUDA support, run
`npm install` in the extracted folder to download the CUDA prebuilt.

## To verify the checksum

```powershell
Get-FileHash .\ModelDuck-Windows-x64.zip -Algorithm SHA256
# Expected: 5766974A458D949DD8324D137AB7C16474C21F14B297307CA90A49BEC39CB254
```

## Build instructions (to reproduce)

The zip was assembled manually from the project root by copying:
- All tracked source directories
- Root tracked files
- `node_modules` with CUDA and arm64 prebuilts excluded

To reproduce with a full CUDA build, run `npm install` in the extracted folder.
