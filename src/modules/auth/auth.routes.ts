import { Router } from "express";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/auth.js";
import { createLimiter } from "../../middleware/security.js";
import { validateBody } from "../../middleware/validate.js";
import { toPublicUser } from "../users/user.model.js";
import { forgotPasswordSchema, loginSchema, registerSchema } from "./auth.schemas.js";
import { authenticateUser, registerUser } from "./auth.service.js";
import { endSession, refreshSession, startSession } from "./session.service.js";

const limiter = createLimiter(env.AUTH_RATE_LIMIT);
// Refreshing happens on every page load of a signed-out visitor, so it gets its own, looser budget.
const refreshLimiter = createLimiter(env.AUTH_RATE_LIMIT * 10);

export const authRouter = Router();

authRouter.post("/register", limiter, validateBody(registerSchema), async (req, res) => {
  const user = await registerUser(req.body);
  await startSession(req, res, user);
  res.status(201).json({ data: toPublicUser(user), message: "Account created" });
});

authRouter.post("/login", limiter, validateBody(loginSchema), async (req, res) => {
  const user = await authenticateUser(req.body.email, req.body.password);
  await startSession(req, res, user);
  res.json({ data: toPublicUser(user), message: "Signed in" });
});

// Called by the web app when the short-lived access token has expired.
authRouter.post("/refresh", refreshLimiter, async (req, res) => {
  const user = await refreshSession(req, res);
  res.json({ data: toPublicUser(user), message: "Session refreshed" });
});

authRouter.post("/logout", async (req, res) => {
  await endSession(req, res);
  res.json({ message: "Signed out" });
});

authRouter.get("/me", authenticate, (req, res) => {
  res.json({ data: toPublicUser(req.user!) });
});

// Email delivery is not built yet. The response is identical whether or not the account exists.
authRouter.post("/forgot-password", limiter, validateBody(forgotPasswordSchema), (_req, res) => {
  res.json({ message: "If that email is registered, a reset link is on its way." });
});
