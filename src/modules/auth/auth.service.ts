import argon2 from "argon2";
import { User } from "../users/user.model.js";
import { conflict, forbidden, unauthorized } from "../../shared/errors.js";

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

export async function authenticateUser(email: string, password: string) {
  const user = await User.findOne({ email }).select("+passwordHash");
  // Same error for unknown email and wrong password so accounts cannot be enumerated.
  if (!user || !(await argon2.verify(user.passwordHash, password))) throw unauthorized("Invalid email or password");
  if (user.status !== "active") throw forbidden("This account is suspended");
  return user;
}
