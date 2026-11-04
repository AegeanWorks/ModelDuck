import fs from "node:fs";
import path from "node:path";

import { AppError } from "./errors.js";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
    "frame-ancestors 'none'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackConnection(req) {
  const address = String(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? "");
  return LOOPBACK_ADDRESSES.has(address);
}

/**
 * `/v1/*` always needs a key when auth is on. `/api/*` needs one only when the
 * request comes from another machine, so the host's own browser UI keeps working
 * without storing a key.
 */
export function requiresApiAuth(req, { requireAuth = false, pathname = "" } = {}) {
  if (!requireAuth) return false;
  if (isApiV1Path(pathname)) return true;
  return pathname.startsWith("/api/") && !isLoopbackConnection(req);
}

export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

export function applyCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function isApiV1Path(pathname) {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

/**
 * True when a browser sent the request from a page on another origin. Requests
 * without an Origin header (API clients, top-level navigation) and same-origin
 * requests from the UI, on loopback or over the LAN, are not cross-site.
 */
export function isCrossSiteRequest(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers.host || "").toLowerCase();
    const defaultPort = parsed.protocol === "https:" ? ":443" : ":80";
    return parsed.host.toLowerCase() !== host.replace(new RegExp(`${defaultPort}$`), "");
  } catch {
    return true;
  }
}

/**
 * A loopback connection must name a loopback host even in LAN mode, so a
 * DNS-rebound page in this computer's browser cannot pass as the local UI.
 * Other machines are accepted only when LAN serving is on; they then need a
 * key for /api (requiresApiAuth). The page's origin is checked separately by
 * isCrossSiteRequest.
 */
export function isLoopbackRequest(req, { allowLan = false } = {}) {
  if (!isLoopbackConnection(req)) return allowLan;
  const host = String(req.headers.host || "");
  let hostname;
  if (host.startsWith("[")) {
    hostname = host.slice(1, host.indexOf("]"));
  } else {
    hostname = host.split(":")[0];
  }
  return LOOPBACK_NAMES.has(hostname.toLowerCase());
}

export function sendJson(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export function sendError(res, error) {
  const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
  const body = {
    error: {
      code: error?.code || "internal_error",
      message: error?.message || "Something went wrong",
      why: error?.why || "ModelDuck hit an unexpected error.",
      fix: error?.fix || "Check the terminal window, then try again.",
    },
  };
  sendJson(res, status, body);
}

export function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

export function sseSend(res, event, data) {
  // IDEA-1197: return the write outcome so slow consumers apply backpressure.
  return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sseComment(res, text = "keep-alive") {
  return res.write(`: ${text}\n\n`);
}

/** IDEA-1197: one write for a burst of frames instead of one write per frame. */
export function sseSendBatched(res, frames) {
  if (!Array.isArray(frames) || frames.length === 0) return true;
  return res.write(frames.join(""));
}

/** IDEA-1197: admit backpressure once the socket buffer passes the limit. */
export function sseNeedsDrain(res, limitBytes = 65536) {
  return (res.writableLength ?? 0) > limitBytes;
}

/** IDEA-1197: wait until the socket drains, errors, or closes. */
export function sseWaitForDrain(res) {
  return new Promise((resolve) => {
    res.once("drain", resolve);
    res.once("error", resolve);
    res.once("close", resolve);
  });
}

export async function readJsonBody(req, { limitBytes = 2 * 1024 * 1024 } = {}) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new AppError("Request body is too large", {
        code: "body_too_large",
        status: 413,
        why: `The request is larger than ${Math.round(limitBytes / 1024)} KB.`,
        fix: "Send a shorter message or a smaller request body.",
      });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("Invalid JSON", {
      code: "invalid_json",
      why: "The request body is not valid JSON.",
      fix: "Check the request and try again.",
    });
  }
}

export function resolvePublicPath(publicDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

export async function servePublicFile(req, res, publicDir, urlPath) {
  const file = resolvePublicPath(publicDir, urlPath);
  if (!file) {
    sendJson(res, 404, { error: { code: "not_found", message: "Not found" } });
    return true;
  }
  let stats;
  try {
    stats = await fs.promises.stat(file);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;

  const extension = path.extname(file).toLowerCase();
  const contentType = MIME_TYPES.get(extension) || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stats.size,
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=0, must-revalidate",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
  return true;
}
