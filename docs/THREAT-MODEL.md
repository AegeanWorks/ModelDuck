# ModelDuck Threat Model (local inference)

Scope: GGUF weights, prompts and settings stay on this computer. The only
network requests are model downloads you start. No telemetry.

## Parties

1. **User** — trusted operator. Risk: pasting secrets into chat; a secret in
   a prompt stays in history and tune answers. Mitigation: keep secrets out
   of prompts; history lives under `~/.modelduck`.
2. **Model publisher** — weights and chat template come from Hugging Face.
   Risk: hostile or damaged GGUF. Mitigation: header guard refuses bad files,
   SHA-256 pinned downloads with `.part` resume, Blocked listing.
3. **Host OS** — Windows/macOS/Linux running Node 20. Risk: another process
   reads `~/.modelduck` or swaps a GGUF. Mitigation: home lock, atomic writes
   with backups, quarantine corrupt files.
4. **LAN clients** — browsers or tools on the local network. Risk: remote
   drive-by calls. Mitigation: loopback-only by default, Host/Origin checks,
   optional API keys, CORS off unless keys are on.
5. **Skill/tool publisher** — future MCP adapter, currently no tools exposed.
   Risk: a tool exfiltrates prompts. Mitigation: switches persist off, OpenAI
   surface rejects `tools`/`logit_bias` instead of silently ignoring them.
6. **Benchmark publisher** — suite items and public sets (GSM8K, MMLU,
   TruthfulQA, HumanEval, MBPP). Risk: public items may be in training data.
   Mitigation: own vs public rates split, test-hash gates, sandbox with
   `node --permission` and 5 s timeout.
7. **Runtime supplier** — `node-llama-cpp` prebuilt binaries. Risk: download
   or compile on demand. Mitigation: `build: never`, CPU fallback, GPU start
   is explicit, version attested in manifests.

## Out of scope

Cloud accounts, remote inference, multi-user hosting. Physical access and a
compromised OS are not defended here.

See `README.md` Where things live and API server settings.
