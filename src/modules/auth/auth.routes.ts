import { Router } from "express";
import rateLimit from "express-rate-limit";
import { SESSION_COOKIE, authenticate, sessionCookieOptions, signSession } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { toPublicUser } from "../users/user.model.js";
import { forgotPasswordSchema, loginSchema, registerSchema } from "./auth.schemas.js";
import { authenticateUser, registerUser } from "./auth.service.js";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later.", details: [] } },
});

export const authRouter = Router();

authRouter.post("/register", limiter, validateBody(registerSchema), async (req, res) => {
  const user = await registerUser(req.body);
  res.cookie(SESSION_COOKIE, signSession(user.id), sessionCookieOptions);
  res.status(201).json({ data: toPublicUser(user), message: "Account created" });
});

authRouter.post("/login", limiter, validateBody(loginSchema), async (req, res) => {
  const user = await authenticateUser(req.body.email, req.body.password);
  res.cookie(SESSION_COOKIE, signSession(user.id), sessionCookieOptions);
  res.json({ data: toPublicUser(user), message: "Signed in" });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions, maxAge: undefined });
  res.json({ message: "Signed out" });
});

authRouter.get("/me", authenticate, (req, res) => {
  res.json({ data: toPublicUser(req.user!) });
});

// Email delivery is not built yet. The response is identical whether or not the account exists.
authRouter.post("/forgot-password", limiter, validateBody(forgotPasswordSchema), (_req, res) => {
  res.json({ message: "If that email is registered, a reset link is on its way." });
});
