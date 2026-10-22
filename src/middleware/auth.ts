import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User, type UserDoc, type Role } from "../modules/users/user.model.js";
import { forbidden, unauthorized } from "../shared/errors.js";

export const ACCESS_COOKIE = "ls_access";
export const REFRESH_COOKIE = "ls_refresh";
export const ACCESS_TTL_SECONDS = 15 * 60; // short-lived: a stolen access token is useful for minutes only
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

declare module "express-serve-static-core" {
  interface Request {
    user?: UserDoc;
  }
}

const baseCookie = { httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production" } as const;
export const accessCookieOptions = { ...baseCookie, maxAge: ACCESS_TTL_SECONDS * 1000, path: "/" } as const;
// The refresh cookie is only ever sent to the auth endpoints, never with ordinary API calls.
export const refreshCookieOptions = { ...baseCookie, maxAge: REFRESH_TTL_SECONDS * 1000, path: "/api/v1/auth" } as const;

export function signAccessToken(userId: string) {
  return jwt.sign({ sub: userId, typ: "access" }, env.SESSION_SECRET, { algorithm: "HS256", expiresIn: ACCESS_TTL_SECONDS });
}

async function userFromRequest(token: string | undefined) {
  if (!token) return null;
  // The algorithm is pinned so a forged "alg: none" or asymmetric-key token is rejected.
  const payload = jwt.verify(token, env.SESSION_SECRET, { algorithms: ["HS256"] }) as { sub: string; typ?: string };
  if (payload.typ !== "access") return null;
  return User.findById(payload.sub);
}

/** Requires a valid access token. Loads the user fresh so suspended accounts lose access immediately. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  if (!req.cookies?.[ACCESS_COOKIE]) return next(unauthorized());
  try {
    const user = await userFromRequest(req.cookies[ACCESS_COOKIE]);
    if (!user) return next(unauthorized());
    if (user.status !== "active") return next(forbidden("This account is suspended"));
    req.user = user;
    next();
  } catch {
    next(unauthorized("Session expired or invalid"));
  }
};

/** Public endpoints that behave differently for signed-in users. Invalid or missing sessions are ignored. */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    const user = await userFromRequest(req.cookies?.[ACCESS_COOKIE]);
    if (user && user.status === "active") req.user = user;
  } catch {
    // treat as signed out
  }
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Authenticates the request and, when roles are given, requires one of them. Use per route so unmatched URLs still 404. */
export function protect(...roles: Role[]): RequestHandler[] {
  return roles.length ? [authenticate, requireRole(...roles)] : [authenticate];
}
