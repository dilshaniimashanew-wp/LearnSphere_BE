import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email"));

export const passwordRule = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128)
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[0-9]/, "Include a number");

// strict(): an unexpected field such as "role: admin" is rejected, never silently accepted.
export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    email,
    password: passwordRule,
    role: z.enum(["student", "instructor"]).default("student"),
  })
  .strict();

export const loginSchema = z.object({ email, password: z.string().min(1) }).strict();

export const forgotPasswordSchema = z.object({ email }).strict();
