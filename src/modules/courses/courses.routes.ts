import { Router } from "express";
import { optionalAuth, protect } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { assertCanViewContent, assertOwner, assertOwnerOrAdmin, loadCourse, oid } from "../../shared/helpers.js";
import { LessonProgress } from "../enrollments/enrollment.model.js";
import { Category, Course, CourseModule, Lesson } from "./course.model.js";
import { presentCourse, presentCourses } from "./course.presenter.js";
import * as schemas from "./course.schemas.js";
import * as courses from "./course.service.js";

export const coursesRouter = Router();

// ---------- Catalog (public: published only) ----------
coursesRouter.get("/courses", async (req, res) => {
  res.json({ data: await courses.listPublished(req.query) });
});

coursesRouter.get("/categories", async (_req, res) => {
  const items = await Category.find({ active: true }).sort({ name: 1 }).lean();
  res.json({ data: items.map((c) => ({ id: String(c._id), name: c.name, slug: c.slug })) });
});

// ---------- Instructor: my courses ----------
// Registered before "/courses/:courseId" so "mine" is not read as an id.
coursesRouter.get("/courses/mine", ...protect("instructor"), async (req, res) => {
  const mine = await Course.find({ instructorId: req.user!._id }).sort({ updatedAt: -1 });
  res.json({ data: await presentCourses(mine) });
});

coursesRouter.post("/courses", ...protect("instructor"), validateBody(schemas.createCourseBody), async (req, res) => {
  const course = await courses.createCourse(req.user!, req.body);
  res.status(201).json({ data: await presentCourse(course), message: "Draft created" });
});

// ---------- Course detail (public if published; otherwise owner/admin) ----------
coursesRouter.get("/courses/:courseId", optionalAuth, async (req, res) => {
  const { course, enrolled, canSeeContent } = await courses.findVisible(String(req.params.courseId), req.user);
  res.json({ data: { ...(await presentCourse(course, { withOutline: true, withContent: canSeeContent })), enrolled } });
});

coursesRouter.patch("/courses/:courseId", ...protect("instructor"), validateBody(schemas.updateCourseBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  res.json({ data: await presentCourse(await courses.updateCourse(course, req.body)), message: "Course updated" });
});

coursesRouter.post("/courses/:courseId/submit-review", ...protect("instructor"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  res.json({ data: await presentCourse(await courses.submitForReview(course)), message: "Submitted for review" });
});

coursesRouter.post("/courses/:courseId/archive", ...protect("instructor", "admin"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwnerOrAdmin(course, req.user!);
  res.json({ data: await presentCourse(await courses.archiveCourse(course)), message: "Course archived" });
});

// ---------- Content (enrolled students, owner, admin) ----------
coursesRouter.get("/courses/:courseId/lessons", ...protect(), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertCanViewContent(course, req.user!);
  const dto = await presentCourse(course, { withOutline: true, withContent: true });
  const completed =
    req.user!.role === "student"
      ? (await LessonProgress.find({ studentId: req.user!._id, courseId: course._id }).select("lessonId").lean()).map((p) => String(p.lessonId))
      : [];
  res.json({ data: { ...dto, completedLessonIds: completed } });
});

// ---------- Modules (owner only) ----------
coursesRouter.post("/courses/:courseId/modules", ...protect("instructor"), validateBody(schemas.createModuleBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const order = req.body.order ?? (await CourseModule.countDocuments({ courseId: course._id }));
  const mod = await CourseModule.create({ ...req.body, order, courseId: course._id });
  res.status(201).json({ data: { id: mod.id, title: mod.title, order: mod.order }, message: "Module added" });
});

// Registered before "/modules/:moduleId" routes for clarity; the paths do not overlap.
coursesRouter.patch("/courses/:courseId/modules/reorder", ...protect("instructor"), validateBody(schemas.reorderModulesBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  await courses.reorderModules(course, req.body.moduleIds);
  res.json({ message: "Modules reordered" });
});

coursesRouter.patch("/modules/:moduleId/lessons/reorder", ...protect("instructor"), validateBody(schemas.reorderLessonsBody), async (req, res) => {
  const mod = await courses.ownedModule(oid(req.params.moduleId), req.user!);
  await courses.reorderLessons(mod, req.body.lessonIds);
  res.json({ message: "Lessons reordered" });
});

coursesRouter.patch("/modules/:moduleId", ...protect("instructor"), validateBody(schemas.updateModuleBody), async (req, res) => {
  const mod = await courses.ownedModule(oid(req.params.moduleId), req.user!);
  mod.set(req.body);
  await mod.save();
  res.json({ data: { id: mod.id, title: mod.title, order: mod.order } });
});

coursesRouter.delete("/modules/:moduleId", ...protect("instructor"), async (req, res) => {
  const mod = await courses.ownedModule(oid(req.params.moduleId), req.user!);
  await Lesson.deleteMany({ moduleId: mod._id });
  await mod.deleteOne();
  res.json({ message: "Module deleted" });
});

// ---------- Lessons (owner only) ----------
coursesRouter.post("/modules/:moduleId/lessons", ...protect("instructor"), validateBody(schemas.createLessonBody), async (req, res) => {
  const mod = await courses.ownedModule(oid(req.params.moduleId), req.user!);
  const order = req.body.order ?? (await Lesson.countDocuments({ moduleId: mod._id }));
  const lesson = await Lesson.create({ ...req.body, order, courseId: mod.courseId, moduleId: mod._id });
  res.status(201).json({ data: { id: lesson.id, title: lesson.title }, message: "Lesson added" });
});

coursesRouter.patch("/lessons/:lessonId", ...protect("instructor"), validateBody(schemas.updateLessonBody), async (req, res) => {
  const lesson = await courses.ownedLesson(oid(req.params.lessonId), req.user!);
  lesson.set(req.body);
  await lesson.save();
  res.json({ data: { id: lesson.id, title: lesson.title } });
});

coursesRouter.delete("/lessons/:lessonId", ...protect("instructor"), async (req, res) => {
  const lesson = await courses.ownedLesson(oid(req.params.lessonId), req.user!);
  await LessonProgress.deleteMany({ lessonId: lesson._id });
  await lesson.deleteOne();
  res.json({ message: "Lesson deleted" });
});
