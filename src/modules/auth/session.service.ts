import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_TTL_SECONDS, accessCookieOptions, refreshCookieOptions, signAccessToken } from "../../middleware/auth.js";
import { unauthorized } from "../../shared/errors.js";
import { User, type UserDoc } from "../users/user.model.js";
import { RefreshSession } from "./session.model.js";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function clearCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...accessCookieOptions, maxAge: undefined });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
}

/** Signs the user in on this device: a 15 minute access token and a rotating 7 day refresh token. */
export async function startSession(req: Request, res: Response, user: UserDoc) {
  const refreshToken = randomBytes(48).toString("base64url");
  await RefreshSession.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    userAgent: req.get("user-agent")?.slice(0, 300),
  });
  res.cookie(ACCESS_COOKIE, signAccessToken(user.id), accessCookieOptions);
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
}

/**
 * Exchanges a refresh token for a new access token and a NEW refresh token (rotation).
 * A token that was already used is treated as stolen: every session of that user is revoked.
 */
export async function refreshSession(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw unauthorized("Not signed in");
  const tokenHash = hashToken(token);

  // Atomic: only one request can consume a given token.
  const session = await RefreshSession.findOneAndUpdate(
    { tokenHash, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
    { revokedAt: new Date() },
  );
  if (!session) {
    const reused = await RefreshSession.findOne({ tokenHash });
    if (reused) await RefreshSession.deleteMany({ userId: reused.userId });
    clearCookies(res);
    throw unauthorized("Session expired. Please sign in again.");
  }

  const user = await User.findById(session.userId);
  if (!user || user.status !== "active") {
    await RefreshSession.deleteMany({ userId: session.userId });
    clearCookies(res);
    throw unauthorized("Session expired. Please sign in again.");
  }
  await startSession(req, res, user);
  return user;
}

/** Signs out this device only. */
export async function endSession(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) await RefreshSession.deleteOne({ tokenHash: hashToken(token) });
  clearCookies(res);
}

/** Signs the user out everywhere. Used on password change and account suspension. */
export const revokeAllSessions = (userId: unknown) => RefreshSession.deleteMany({ userId: userId as never });
