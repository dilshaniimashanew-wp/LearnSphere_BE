import { isValidObjectId } from "mongoose";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { assertOwner, audit, escapeRegex, isOwner, loadCourse, notify, paginate, uniqueSlug } from "../../shared/helpers.js";
import { Enrollment } from "../enrollments/enrollment.model.js";
import type { UserDoc } from "../users/user.model.js";
import { Category, Course, CourseModule, Lesson, LEVELS, type CourseDoc } from "./course.model.js";
import { presentCourses } from "./course.presenter.js";
import type { CreateCourseInput, UpdateCourseInput } from "./course.schemas.js";

const canSeeUnpublished = (course: CourseDoc, user?: UserDoc) => !!user && (user.role === "admin" || isOwner(course, user));

// ---------- Queries ----------

/** The public catalog: published courses only, with search, filters and pagination. */
export async function listPublished(query: Record<string, unknown>) {
  const { page, pageSize, skip } = paginate(query);
  const filter: Record<string, unknown> = { status: "published" };
  const q = typeof query.q === "string" ? query.q.trim() : "";
  // User input is escaped, so it can never act as a regular expression.
  if (q) filter.$or = [{ title: new RegExp(escapeRegex(q), "i") }, { summary: new RegExp(escapeRegex(q), "i") }];
  if (typeof query.category === "string" && isValidObjectId(query.category)) filter.categoryId = query.category;
  if (typeof query.level === "string" && (LEVELS as readonly string[]).includes(query.level)) filter.level = query.level;
  if (typeof query.instructorId === "string" && isValidObjectId(query.instructorId)) filter.instructorId = query.instructorId;

  const [courses, total] = await Promise.all([Course.find(filter).sort({ publishedAt: -1 }).skip(skip).limit(pageSize), Course.countDocuments(filter)]);
  return { items: await presentCourses(courses), page, pageSize, total };
}

/**
 * Finds a course by id or slug for a (possibly anonymous) viewer. Unpublished courses are
 * invisible to everyone except the owner and admins. Lesson bodies need ownership or enrollment.
 */
export async function findVisible(idOrSlug: string, user?: UserDoc) {
  const course = isValidObjectId(idOrSlug) ? await Course.findById(idOrSlug) : await Course.findOne({ slug: idOrSlug });
  if (!course || (course.status !== "published" && !canSeeUnpublished(course, user))) throw notFound("Course not found");
  const enrolled = !!user && user.role === "student" && !!(await Enrollment.exists({ studentId: user._id, courseId: course._id }));
  return { course, enrolled, canSeeContent: enrolled || canSeeUnpublished(course, user) };
}

// ---------- Instructor use cases ----------

async function assertActiveCategory(categoryId: unknown) {
  if (!(await Category.exists({ _id: categoryId, active: true }))) throw badRequest("Unknown category");
}

export async function createCourse(instructor: UserDoc, input: CreateCourseInput) {
  await assertActiveCategory(input.categoryId);
  return Course.create({ ...input, instructorId: instructor._id, slug: uniqueSlug(input.title), status: "draft" });
}

export async function updateCourse(course: CourseDoc, input: UpdateCourseInput) {
  if (course.status === "archived") throw forbidden("Archived courses cannot be edited");
  if (input.categoryId) await assertActiveCategory(input.categoryId);
  course.set(input);
  return course.save();
}

export async function submitForReview(course: CourseDoc) {
  if (course.status !== "draft" && course.status !== "rejected") throw badRequest(`A ${course.status} course cannot be submitted`);
  if ((await Lesson.countDocuments({ courseId: course._id })) === 0) throw badRequest("Add at least one lesson before submitting for review");
  course.status = "pending_review";
  course.moderationNote = undefined;
  return course.save();
}

export async function archiveCourse(course: CourseDoc) {
  course.status = "archived";
  return course.save();
}

// ---------- Admin moderation ----------

export async function approveCourse(course: CourseDoc, admin: UserDoc) {
  if (course.status !== "pending_review") throw conflict("Only courses pending review can be approved");
  course.status = "published";
  course.publishedAt = new Date();
  course.moderationNote = undefined;
  await course.save();
  await audit(admin, "course.approve", "course", course.id, { title: course.title });
  await notify(course.instructorId, "course_approved", "Course approved", `"${course.title}" is now published.`, "/instructor/courses");
  return course;
}

export async function rejectCourse(course: CourseDoc, admin: UserDoc, note: string) {
  if (course.status !== "pending_review") throw conflict("Only courses pending review can be rejected");
  course.status = "rejected";
  course.moderationNote = note;
  await course.save();
  await audit(admin, "course.reject", "course", course.id, { title: course.title, note });
  await notify(course.instructorId, "course_rejected", "Course needs changes", `"${course.title}" was rejected: ${note}`, "/instructor/courses");
  return course;
}

// ---------- Curriculum ----------

/** The list must be exactly this course's modules, each once. */
export async function reorderModules(course: CourseDoc, ids: string[]) {
  const existing = await CourseModule.find({ courseId: course._id }).select("_id").lean();
  if (new Set(ids).size !== ids.length || ids.length !== existing.length || !existing.every((m) => ids.includes(String(m._id)))) {
    throw badRequest("moduleIds must list every module of this course exactly once");
  }
  await CourseModule.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, courseId: course._id }, update: { $set: { order } } } })));
}

/** Sets the lesson order of one module. Lessons dragged in from another module of the same course move here. */
export async function reorderLessons(mod: { _id: unknown; courseId: unknown }, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw badRequest("Duplicate lesson ids");
  if ((await Lesson.countDocuments({ _id: { $in: ids }, courseId: mod.courseId as never })) !== ids.length)
    throw badRequest("All lessons must belong to this course");
  await Lesson.bulkWrite(
    ids.map((id, order) => ({ updateOne: { filter: { _id: id, courseId: mod.courseId as never }, update: { $set: { order, moduleId: mod._id as never } } } })),
  );
}

export async function ownedModule(moduleId: string, user: UserDoc) {
  const mod = await CourseModule.findById(moduleId);
  if (!mod) throw notFound("Module not found");
  assertOwner(await loadCourse(mod.courseId), user);
  return mod;
}

export async function ownedLesson(lessonId: string, user: UserDoc) {
  const lesson = await Lesson.findById(lessonId);
  if (!lesson) throw notFound("Lesson not found");
  assertOwner(await loadCourse(lesson.courseId), user);
  return lesson;
}
