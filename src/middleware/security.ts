import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
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

export function createLimiter(limit: number, windowMs = 15 * 60 * 1000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later.", details: [] } },
  });
}
