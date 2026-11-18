/**
 * Small helpers shared by the engine adapters and the external engines: how a
 * native llama.cpp binary is found and started on this machine.
 */

/**
 * A MinGW-built llama.cpp dies with a DLL entry-point error (0xC0000139) when Git for Windows'
 * own usr/mingw directories come first on PATH, which is how a Git Bash session starts. The
 * native engine is therefore spawned with those directories removed.
 */
export function cleanPath(pathValue, platform = process.platform) {
  if (platform !== "win32") return pathValue;
  const entries = String(pathValue ?? "").split(";");
  return entries.filter((entry) => !/[\\/]Git[\\/](usr|mingw\d*)([\\/]|$)/i.test(entry)).join(";");
}

/** "version: 0.8.0-dev (build 1, commit cd8427d)" -> "0.8.0-dev (cd8427d)". */
export function parseLlamaVersion(text) {
  const match = /version:\s*(\S+)(?:\s*\(build\s*\d+,\s*commit\s*(\w+)\))?/i.exec(String(text ?? ""));
  return match ? `${match[1]}${match[2] ? ` (${match[2]})` : ""}` : null;
}

export function locateBinary(candidates, exists) {
  return candidates.find((candidate) => candidate && exists(candidate)) ?? null;
}
