import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { forbidden } from "../shared/errors.js";

/**
 * CSRF defence in depth (on top of SameSite cookies and the CORS allowlist): browsers always send an
 * Origin header on cross-site state-changing requests, so a mismatching Origin is refused.
 * Requests without an Origin (curl, server-to-server, tests) are not browser-driven CSRF vectors.
 */
export const sameOriginOnly: RequestHandler = (req, _res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (origin && origin.replace(/\/$/, "") !== env.APP_ORIGIN.replace(/\/$/, "")) return next(forbidden("Cross-origin request blocked"));
  next();
};

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The key rate limits are counted against. When the web app proxies API calls (so the browser talks to one domain),
 * every request arrives from the proxy's address. The proxy therefore sends the real visitor IP in `x-client-ip`,
 * and the API only believes it when the request also carries the shared PROXY_SECRET.
 */
export function clientKey(req: Pick<Request, "headers" | "ip">, secret = env.PROXY_SECRET) {
  const claimed = req.headers["x-client-ip"];
  const proof = req.headers["x-proxy-secret"];
  if (secret && typeof claimed === "string" && typeof proof === "string" && safeEqual(proof, secret)) {
    return ipKeyGenerator(claimed.split(",")[0].trim());
  }
  return ipKeyGenerator(req.ip ?? "unknown");
}

export function createLimiter(limit: number, windowMs = 15 * 60 * 1000) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: (req) => clientKey(req),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later.", details: [] } },
  });
}
