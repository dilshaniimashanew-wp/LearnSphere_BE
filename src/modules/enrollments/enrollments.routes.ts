import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { assertEnrolledStudent, assertOwnerOrAdmin, loadCourse, notify, oid } from "../../shared/helpers.js";
import { Course, Lesson } from "../courses/course.model.js";
import { courseDto } from "../courses/courses.routes.js";
import { User } from "../users/user.model.js";
import { Enrollment, LessonProgress } from "./enrollment.model.js";
import { courseProgress, evaluateCompletion } from "./progress.service.js";

export const enrollmentsRouter = Router();
enrollmentsRouter.use(authenticate);

enrollmentsRouter.post("/courses/:courseId/enroll", requireRole("student"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  if (course.status !== "published") throw forbidden("This course is not open for enrollment");
  try {
    await Enrollment.create({ studentId: req.user!._id, courseId: course._id });
  } catch (e) {
    // The unique studentId+courseId index makes duplicate enrollment impossible even under a race.
    if ((e as { code?: number }).code === 11000) throw conflict("You are already enrolled in this course");
    throw e;
  }
  await notify(course.instructorId, "new_enrollment", "New student", `${req.user!.name} enrolled in ${course.title}.`, "/instructor");
  res.status(201).json({ message: "Enrolled" });
});

enrollmentsRouter.get("/enrollments/me", requireRole("student"), async (req, res) => {
  const enrollments = await Enrollment.find({ studentId: req.user!._id }).sort({ enrolledAt: -1 });
  const items = await Promise.all(
    enrollments.map(async (e) => {
      const course = await Course.findById(e.courseId);
      if (!course) return null;
      const progress = await courseProgress(req.user!._id, course._id);
      const done = new Set(progress.completedLessonIds);
      const next = (await Lesson.find({ courseId: course._id }).sort({ order: 1 }).lean()).find((l) => !done.has(String(l._id)));
      return {
        courseId: course.id,
        course: await courseDto(course),
        status: e.status,
        progress: progress.percent,
        nextLesson: next?.title ?? "",
        enrolledAt: e.enrolledAt,
        completedAt: e.completedAt,
      };
    }),
  );
  res.json({ data: items.filter(Boolean) });
});

enrollmentsRouter.get("/courses/:courseId/students", requireRole("instructor", "admin"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwnerOrAdmin(course, req.user!);
  const enrollments = await Enrollment.find({ courseId: course._id }).sort({ enrolledAt: -1 }).lean();
  const users = await User.find({ _id: { $in: enrollments.map((e) => e.studentId) } }).select("name email").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const items = await Promise.all(
    enrollments.map(async (e) => ({
      studentId: String(e.studentId),
      name: byId.get(String(e.studentId))?.name,
      email: byId.get(String(e.studentId))?.email,
      status: e.status,
      progress: (await courseProgress(e.studentId, course._id)).percent,
      enrolledAt: e.enrolledAt,
    })),
  );
  res.json({ data: items });
});

enrollmentsRouter.get("/courses/:courseId/progress", requireRole("student"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertEnrolledStudent(course, req.user!);
  res.json({ data: await courseProgress(req.user!._id, course._id) });
});

const progressBody = z.object({ completed: z.boolean() }).strict();

enrollmentsRouter.post("/lessons/:lessonId/progress", requireRole("student"), validateBody(progressBody), async (req, res) => {
  const lesson = await Lesson.findById(oid(req.params.lessonId));
  if (!lesson) throw notFound("Lesson not found");
  const course = await loadCourse(lesson.courseId);
  await assertEnrolledStudent(course, req.user!);
  if (course.status === "archived") throw badRequest("This course is archived");

  if (req.body.completed) {
    // Upsert keeps this idempotent: marking twice never creates duplicates.
    await LessonProgress.updateOne(
      { studentId: req.user!._id, lessonId: lesson._id },
      { $setOnInsert: { courseId: course._id, completedAt: new Date() } },
      { upsert: true },
    );
  } else {
    await LessonProgress.deleteOne({ studentId: req.user!._id, lessonId: lesson._id });
  }
  const progress = await evaluateCompletion(req.user!._id, course._id);
  res.json({ data: progress });
});
