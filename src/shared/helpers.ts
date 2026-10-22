import { randomBytes } from "node:crypto";
import { isValidObjectId, Types } from "mongoose";
import { Course, type CourseDoc } from "../modules/courses/course.model.js";
import { Enrollment } from "../modules/enrollments/enrollment.model.js";
import { AuditLog, Notification } from "../modules/platform/platform.model.js";
import type { UserDoc } from "../modules/users/user.model.js";
import { forbidden, notFound } from "./errors.js";

/** Route ids that are not valid ObjectIds are simply "not found". */
export function oid(value: unknown): string {
  // Accepts a route string or an ObjectId read from another document.
  const id = typeof value === "string" ? value : value instanceof Types.ObjectId ? value.toHexString() : "";
  if (!isValidObjectId(id)) throw notFound();
  return id;
}

export function paginate(query: Record<string, unknown>, defaultSize = 12) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || defaultSize));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

export const uniqueSlug = (text: string) => `${slugify(text) || "item"}-${randomBytes(2).toString("hex")}`;

export async function loadCourse(courseId: unknown): Promise<CourseDoc> {
  const course = await Course.findById(oid(courseId));
  if (!course) throw notFound("Course not found");
  return course;
}

export const isOwner = (course: { instructorId: Types.ObjectId }, user: UserDoc) => course.instructorId.equals(user._id);

/** Course owner, or an admin (who may audit or override). */
export function assertOwnerOrAdmin(course: { instructorId: Types.ObjectId }, user: UserDoc) {
  if (user.role === "admin" || (user.role === "instructor" && isOwner(course, user))) return;
  throw forbidden("You do not own this course");
}

/** Only the owning instructor. Used for editing content. */
export function assertOwner(course: { instructorId: Types.ObjectId }, user: UserDoc) {
  if (user.role === "instructor" && isOwner(course, user)) return;
  throw forbidden("You do not own this course");
}

export async function assertCanViewContent(course: CourseDoc, user: UserDoc) {
  if (user.role === "admin" || isOwner(course, user)) return;
  if (user.role === "student" && (await Enrollment.exists({ studentId: user._id, courseId: course._id }))) return;
  throw forbidden("Enroll in this course to access its content");
}

export async function assertEnrolledStudent(course: CourseDoc, user: UserDoc) {
  if (user.role !== "student") throw forbidden("Only students can do this");
  const enrollment = await Enrollment.findOne({ studentId: user._id, courseId: course._id });
  if (!enrollment) throw forbidden("You are not enrolled in this course");
  return enrollment;
}

export async function notify(recipientId: Types.ObjectId | string, type: string, title: string, body: string, link?: string) {
  await Notification.create({ recipientId, type, title, body, link });
}

/** Never put passwords or tokens in metadata. */
export async function audit(actor: UserDoc, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) {
  await AuditLog.create({ actorId: actor._id, action, targetType, targetId, metadata });
}
