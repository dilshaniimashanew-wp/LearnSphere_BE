import { Schema, model } from "mongoose";

const certificateSchema = new Schema(
  {
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
    certificateCode: { type: String, required: true, unique: true },
    issuedAt: { type: Date, default: Date.now },
    revokedAt: Date,
  },
  { timestamps: true },
);
certificateSchema.index({ studentId: 1, courseId: 1 }, { unique: true });
export const Certificate = model("Certificate", certificateSchema);

const notificationSchema = new Schema(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    link: String,
    readAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ recipientId: 1, readAt: 1 });
export const Notification = model("Notification", notificationSchema);

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: String,
    metadata: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ createdAt: -1 });
export const AuditLog = model("AuditLog", auditLogSchema);
