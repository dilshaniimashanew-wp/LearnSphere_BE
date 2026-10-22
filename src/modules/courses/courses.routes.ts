import { Router } from "express";
import { httpUrl, httpsUrl } from "../../shared/schemas.js";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { authenticate, optionalAuth, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { badRequest, forbidden, notFound } from "../../shared/errors.js";
import { assertCanViewContent, assertOwner, assertOwnerOrAdmin, escapeRegex, isOwner, loadCourse, oid, paginate, uniqueSlug } from "../../shared/helpers.js";
import { Enrollment, LessonProgress } from "../enrollments/enrollment.model.js";
import { Review } from "../platform/platform.model.js";
import { User, type UserDoc } from "../users/user.model.js";
import { Category, Course, CourseModule, Lesson, LEVELS, type CourseDoc } from "./course.model.js";

export const coursesRouter = Router();

const courseBody = z
  .object({
    title: z.string().trim().min(5).max(120),
    summary: z.string().trim().min(10).max(240),
    description: z.string().trim().min(30),
    categoryId: z.string().refine(isValidObjectId, "Invalid category"),
    level: z.enum(LEVELS),
    objectives: z.array(z.string().trim().min(1)).max(20).default([]),
    prerequisites: z.array(z.string().trim().min(1)).max(20).default([]),
    thumbnailUrl: httpsUrl.nullable().optional(),
  })
  .strict();

const moduleBody = z.object({ title: z.string().trim().min(2).max(120), description: z.string().trim().max(500).optional(), order: z.number().int().min(0).optional() }).strict();
const lessonBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    type: z.enum(["text", "video"]).default("text"),
    content: z.string().default(""),
    videoUrl: httpUrl.optional(),
    order: z.number().int().min(0).optional(),
    isRequired: z.boolean().default(true),
    estimatedMinutes: z.number().int().min(1).max(600).default(10),
  })
  .strict();

/** Public-safe course shape. Lesson bodies are only included when `withContent` is set. */
export async function courseDto(course: CourseDoc, opts: { withOutline?: boolean; withContent?: boolean } = {}) {
  const [instructor, category, lessonAgg, students, ratingAgg] = await Promise.all([
    User.findById(course.instructorId).select("name").lean(),
    Category.findById(course.categoryId).select("name").lean(),
    Lesson.aggregate([{ $match: { courseId: course._id } }, { $group: { _id: null, count: { $sum: 1 }, minutes: { $sum: "$estimatedMinutes" } } }]),
    Enrollment.countDocuments({ courseId: course._id }),
    Review.aggregate([{ $match: { courseId: course._id } }, { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } }]),
  ]);
  const dto: Record<string, unknown> = {
    id: course.id,
    slug: course.slug,
    title: course.title,
    summary: course.summary,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl,
    categoryId: String(course.categoryId),
    category: category?.name ?? "Uncategorised",
    level: course.level,
    instructor: instructor?.name ?? "Unknown",
    instructorId: String(course.instructorId),
    status: course.status,
    moderationNote: course.moderationNote,
    objectives: course.objectives,
    prerequisites: course.prerequisites,
    durationMinutes: lessonAgg[0]?.minutes ?? 0,
    lessonCount: lessonAgg[0]?.count ?? 0,
    students,
    rating: ratingAgg[0] ? Math.round(ratingAgg[0].avg * 10) / 10 : 0,
    reviewCount: ratingAgg[0]?.count ?? 0,
    publishedAt: course.publishedAt,
  };
  if (opts.withOutline) {
    const [modules, lessons] = await Promise.all([
      CourseModule.find({ courseId: course._id }).sort({ order: 1, createdAt: 1 }).lean(),
      Lesson.find({ courseId: course._id }).sort({ order: 1, createdAt: 1 }).lean(),
    ]);
    dto.modules = modules.map((m) => ({
      id: String(m._id),
      title: m.title,
      description: m.description,
      order: m.order,
      lessons: lessons
        .filter((l) => String(l.moduleId) === String(m._id))
        .map((l) => ({
          id: String(l._id),
          title: l.title,
          type: l.type,
          minutes: l.estimatedMinutes,
          isRequired: l.isRequired,
          order: l.order,
          ...(opts.withContent ? { content: l.content, videoUrl: l.videoUrl } : {}),
        })),
    }));
  }
  return dto;
}

/** Whether `user` may see a non-published course at all. */
function canSeeUnpublished(course: CourseDoc, user?: UserDoc) {
  return !!user && (user.role === "admin" || isOwner(course, user));
}

// ---------- Catalog (public: published only) ----------
coursesRouter.get("/courses", async (req, res) => {
  const { page, pageSize, skip } = paginate(req.query);
  const filter: Record<string, unknown> = { status: "published" };
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q) filter.$or = [{ title: new RegExp(escapeRegex(q), "i") }, { summary: new RegExp(escapeRegex(q), "i") }];
  if (typeof req.query.category === "string" && isValidObjectId(req.query.category)) filter.categoryId = req.query.category;
  if (typeof req.query.level === "string" && (LEVELS as readonly string[]).includes(req.query.level)) filter.level = req.query.level;
  if (typeof req.query.instructorId === "string" && isValidObjectId(req.query.instructorId)) filter.instructorId = req.query.instructorId;

  const [courses, total] = await Promise.all([Course.find(filter).sort({ publishedAt: -1 }).skip(skip).limit(pageSize), Course.countDocuments(filter)]);
  res.json({ data: { items: await Promise.all(courses.map((c) => courseDto(c))), page, pageSize, total } });
});

coursesRouter.get("/categories", async (_req, res) => {
  const items = await Category.find({ active: true }).sort({ name: 1 }).lean();
  res.json({ data: items.map((c) => ({ id: String(c._id), name: c.name, slug: c.slug })) });
});

// ---------- Instructor: my courses ----------
coursesRouter.get("/courses/mine", authenticate, requireRole("instructor"), async (req, res) => {
  const courses = await Course.find({ instructorId: req.user!._id }).sort({ updatedAt: -1 });
  res.json({ data: await Promise.all(courses.map((c) => courseDto(c))) });
});

coursesRouter.post("/courses", authenticate, requireRole("instructor"), validateBody(courseBody), async (req, res) => {
  if (!(await Category.exists({ _id: req.body.categoryId, active: true }))) throw badRequest("Unknown category");
  const course = await Course.create({ ...req.body, instructorId: req.user!._id, slug: uniqueSlug(req.body.title), status: "draft" });
  res.status(201).json({ data: await courseDto(course), message: "Draft created" });
});

// ---------- Course detail (public if published; otherwise owner/admin) ----------
coursesRouter.get("/courses/:courseId", optionalAuth, async (req, res) => {
  const idOrSlug = String(req.params.courseId);
  const course = isValidObjectId(idOrSlug) ? await Course.findById(idOrSlug) : await Course.findOne({ slug: idOrSlug });
  if (!course || (course.status !== "published" && !canSeeUnpublished(course, req.user))) throw notFound("Course not found");

  // Lesson bodies are private: only the owner, an admin or an enrolled student sees them.
  let withContent = false;
  let enrolled = false;
  if (req.user) {
    enrolled = req.user.role === "student" && !!(await Enrollment.exists({ studentId: req.user._id, courseId: course._id }));
    withContent = enrolled || canSeeUnpublished(course, req.user);
  }
  res.json({ data: { ...(await courseDto(course, { withOutline: true, withContent })), enrolled } });
});

coursesRouter.patch("/courses/:courseId", authenticate, requireRole("instructor"), validateBody(courseBody.partial()), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  if (course.status === "archived") throw forbidden("Archived courses cannot be edited");
  if (req.body.categoryId && !(await Category.exists({ _id: req.body.categoryId, active: true }))) throw badRequest("Unknown category");
  course.set(req.body);
  await course.save();
  res.json({ data: await courseDto(course), message: "Course updated" });
});

coursesRouter.post("/courses/:courseId/submit-review", authenticate, requireRole("instructor"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  if (course.status !== "draft" && course.status !== "rejected") throw badRequest(`A ${course.status} course cannot be submitted`);
  if ((await Lesson.countDocuments({ courseId: course._id })) === 0) throw badRequest("Add at least one lesson before submitting for review");
  course.status = "pending_review";
  course.moderationNote = undefined;
  await course.save();
  res.json({ data: await courseDto(course), message: "Submitted for review" });
});

coursesRouter.post("/courses/:courseId/archive", authenticate, requireRole("instructor", "admin"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwnerOrAdmin(course, req.user!);
  course.status = "archived";
  await course.save();
  res.json({ data: await courseDto(course), message: "Course archived" });
});

// ---------- Content (enrolled students, owner, admin) ----------
coursesRouter.get("/courses/:courseId/lessons", authenticate, async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertCanViewContent(course, req.user!);
  const dto = await courseDto(course, { withOutline: true, withContent: true });
  let completed: string[] = [];
  if (req.user!.role === "student") {
    completed = (await LessonProgress.find({ studentId: req.user!._id, courseId: course._id }).select("lessonId").lean()).map((p) => String(p.lessonId));
  }
  res.json({ data: { ...dto, completedLessonIds: completed } });
});

// ---------- Modules & lessons (owner only) ----------
coursesRouter.post("/courses/:courseId/modules", authenticate, requireRole("instructor"), validateBody(moduleBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const order = req.body.order ?? (await CourseModule.countDocuments({ courseId: course._id }));
  const mod = await CourseModule.create({ ...req.body, order, courseId: course._id });
  res.status(201).json({ data: { id: mod.id, title: mod.title, order: mod.order }, message: "Module added" });
});

async function loadModuleOwned(moduleId: unknown, user: UserDoc) {
  const mod = await CourseModule.findById(oid(moduleId));
  if (!mod) throw notFound("Module not found");
  assertOwner(await loadCourse(mod.courseId), user);
  return mod;
}

// ---------- Reordering (owner only) ----------
const reorderModulesBody = z.object({ moduleIds: z.array(z.string().refine(isValidObjectId)).min(1) }).strict();
coursesRouter.patch("/courses/:courseId/modules/reorder", authenticate, requireRole("instructor"), validateBody(reorderModulesBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const ids: string[] = req.body.moduleIds;
  const existing = await CourseModule.find({ courseId: course._id }).select("_id").lean();
  // The list must be exactly this course's modules, each once.
  if (new Set(ids).size !== ids.length || ids.length !== existing.length || !existing.every((m) => ids.includes(String(m._id)))) {
    throw badRequest("moduleIds must list every module of this course exactly once");
  }
  await CourseModule.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, courseId: course._id }, update: { $set: { order } } } })));
  res.json({ message: "Modules reordered" });
});

/** Sets the lesson order of one module. Lessons dragged in from another module of the same course move here. */
const reorderLessonsBody = z.object({ lessonIds: z.array(z.string().refine(isValidObjectId)).max(500) }).strict();
coursesRouter.patch("/modules/:moduleId/lessons/reorder", authenticate, requireRole("instructor"), validateBody(reorderLessonsBody), async (req, res) => {
  const mod = await loadModuleOwned(req.params.moduleId, req.user!);
  const ids: string[] = req.body.lessonIds;
  if (new Set(ids).size !== ids.length) throw badRequest("Duplicate lesson ids");
  const found = await Lesson.countDocuments({ _id: { $in: ids }, courseId: mod.courseId });
  if (found !== ids.length) throw badRequest("All lessons must belong to this course");
  await Lesson.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, courseId: mod.courseId }, update: { $set: { order, moduleId: mod._id } } } })));
  res.json({ message: "Lessons reordered" });
});

coursesRouter.patch("/modules/:moduleId", authenticate, requireRole("instructor"), validateBody(moduleBody.partial()), async (req, res) => {
  const mod = await loadModuleOwned(req.params.moduleId, req.user!);
  mod.set(req.body);
  await mod.save();
  res.json({ data: { id: mod.id, title: mod.title, order: mod.order } });
});

coursesRouter.delete("/modules/:moduleId", authenticate, requireRole("instructor"), async (req, res) => {
  const mod = await loadModuleOwned(req.params.moduleId, req.user!);
  await Lesson.deleteMany({ moduleId: mod._id });
  await mod.deleteOne();
  res.json({ message: "Module deleted" });
});

coursesRouter.post("/modules/:moduleId/lessons", authenticate, requireRole("instructor"), validateBody(lessonBody), async (req, res) => {
  const mod = await loadModuleOwned(req.params.moduleId, req.user!);
  const order = req.body.order ?? (await Lesson.countDocuments({ moduleId: mod._id }));
  const lesson = await Lesson.create({ ...req.body, order, courseId: mod.courseId, moduleId: mod._id });
  res.status(201).json({ data: { id: lesson.id, title: lesson.title }, message: "Lesson added" });
});

async function loadLessonOwned(lessonId: unknown, user: UserDoc) {
  const lesson = await Lesson.findById(oid(lessonId));
  if (!lesson) throw notFound("Lesson not found");
  assertOwner(await loadCourse(lesson.courseId), user);
  return lesson;
}

coursesRouter.patch("/lessons/:lessonId", authenticate, requireRole("instructor"), validateBody(lessonBody.partial()), async (req, res) => {
  const lesson = await loadLessonOwned(req.params.lessonId, req.user!);
  lesson.set(req.body);
  await lesson.save();
  res.json({ data: { id: lesson.id, title: lesson.title } });
});

coursesRouter.delete("/lessons/:lessonId", authenticate, requireRole("instructor"), async (req, res) => {
  const lesson = await loadLessonOwned(req.params.lessonId, req.user!);
  await LessonProgress.deleteMany({ lessonId: lesson._id });
  await lesson.deleteOne();
  res.json({ message: "Lesson deleted" });
});
