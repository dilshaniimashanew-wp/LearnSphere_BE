import argon2 from "argon2";
import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { unauthorized } from "../../shared/errors.js";
import { passwordRule } from "../auth/auth.schemas.js";
import { hashPassword } from "../auth/auth.service.js";
import { User, toPublicUser } from "./user.model.js";

const updateProfileSchema = z.object({ name: z.string().trim().min(2).max(80) }).strict();
const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordRule }).strict();

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get("/me", (req, res) => {
  res.json({ data: toPublicUser(req.user!) });
});

usersRouter.patch("/me", validateBody(updateProfileSchema), async (req, res) => {
  const user = req.user!;
  user.name = req.body.name;
  await user.save();
  res.json({ data: toPublicUser(user), message: "Profile updated" });
});

usersRouter.patch("/me/password", validateBody(changePasswordSchema), async (req, res) => {
  const user = await User.findById(req.user!.id).select("+passwordHash");
  if (!user || !(await argon2.verify(user.passwordHash, req.body.currentPassword))) {
    throw unauthorized("Current password is incorrect");
  }
  user.passwordHash = await hashPassword(req.body.newPassword);
  await user.save();
  res.json({ message: "Password updated" });
});
