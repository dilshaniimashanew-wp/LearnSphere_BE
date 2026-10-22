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

const announcementSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
  },
  { timestamps: true },
);
export const Announcement = model("Announcement", announcementSchema);

const reviewSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);
// One review per student per course.
reviewSchema.index({ courseId: 1, studentId: 1 }, { unique: true });
export const Review = model("Review", reviewSchema);
