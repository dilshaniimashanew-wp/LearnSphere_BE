import argon2 from "argon2";
import { User } from "../users/user.model.js";
import { AppError, conflict, forbidden, unauthorized } from "../../shared/errors.js";

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

export async function registerUser(input: { name: string; email: string; password: string; role: "student" | "instructor" }) {
  if (await User.exists({ email: input.email })) throw conflict("An account with this email already exists");
  return User.create({
    name: input.name,
    email: input.email,
    role: input.role,
    passwordHash: await hashPassword(input.password),
  });
}

// Verified against when the email is unknown, so "no such user" takes as long as "wrong password".
let dummyHash: Promise<string> | undefined;

export async function authenticateUser(email: string, password: string) {
  const user = await User.findOne({ email }).select("+passwordHash");
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, "ACCOUNT_LOCKED", "Too many failed attempts. Try again in a few minutes.");
  }

  const valid = user
    ? await argon2.verify(user.passwordHash, password)
    : (await argon2.verify(await (dummyHash ??= hashPassword("dummy-password-for-timing")), password), false);
  if (!user || !valid) {
    if (user) {
      const updated = await User.findByIdAndUpdate(user._id, { $inc: { failedLoginCount: 1 } }, { returnDocument: "after" });
      if (updated && updated.failedLoginCount >= MAX_FAILED_LOGINS) {
        await User.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000), failedLoginCount: 0 } });
      }
    }
    // Same message for an unknown email and a wrong password, so accounts cannot be enumerated.
    throw unauthorized("Invalid email or password");
  }
  if (user.status !== "active") throw forbidden("This account is suspended");
  if (user.failedLoginCount || user.lockedUntil) await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0 }, $unset: { lockedUntil: 1 } });
  return user;
}
