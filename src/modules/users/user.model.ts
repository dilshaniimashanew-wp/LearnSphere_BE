import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const ROLES = ["student", "instructor", "admin"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: "student", required: true },
    status: { type: String, enum: ["active", "suspended"], default: "active", required: true },
    avatarUrl: String,
    emailVerifiedAt: Date,
    // Brute-force protection: too many wrong passwords lock the account for a while.
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: Date,
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model("User", userSchema);

/** The only shape ever sent to clients: no password hash. */
export function toPublicUser(user: UserDoc) {
  return {
    id: user.id as string,
    name: user.name,
    email: user.email,
    role: user.role as Role,
    status: user.status,
    avatarUrl: user.avatarUrl ?? undefined,
  };
}
