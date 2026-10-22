import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User, type UserDoc, type Role } from "../modules/users/user.model.js";
import { forbidden, unauthorized } from "../shared/errors.js";

export const SESSION_COOKIE = "ls_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 1 day

declare module "express-serve-static-core" {
  interface Request {
    user?: UserDoc;
  }
}

export function signSession(userId: string) {
  return jwt.sign({ sub: userId }, env.SESSION_SECRET, { expiresIn: SESSION_TTL_SECONDS });
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  maxAge: SESSION_TTL_SECONDS * 1000,
  path: "/",
} as const;

/** Requires a valid session. Loads the user fresh so suspended accounts lose access immediately. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, env.SESSION_SECRET) as { sub: string };
    const user = await User.findById(payload.sub);
    if (!user) return next(unauthorized());
    if (user.status !== "active") return next(forbidden("This account is suspended"));
    req.user = user;
    next();
  } catch {
    next(unauthorized("Session expired or invalid"));
  }
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
