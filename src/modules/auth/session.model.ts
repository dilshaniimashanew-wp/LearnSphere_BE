import { Schema, model } from "mongoose";

/** One row per signed-in device. Only a SHA-256 hash of the refresh token is stored, never the token. */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    // Set when the token has been used (rotated) or signed out. Presenting a revoked token again means it leaked.
    revokedAt: Date,
    userAgent: { type: String, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// MongoDB deletes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshSession = model("RefreshSession", sessionSchema);
