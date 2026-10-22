import { Router } from "express";
import { z } from "zod";
import { protect } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { assertEnrolledStudent, assertOwnerOrAdmin, loadCourse, oid } from "../../shared/helpers.js";
import * as enrollments from "./enrollment.service.js";
import { courseProgress } from "./progress.service.js";

export const enrollmentsRouter = Router();

const progressBody = z.object({ completed: z.boolean() }).strict();

enrollmentsRouter.post("/courses/:courseId/enroll", ...protect("student"), async (req, res) => {
  await enrollments.enroll(req.user!, await loadCourse(req.params.courseId));
  res.status(201).json({ message: "Enrolled" });
});

enrollmentsRouter.get("/enrollments/me", ...protect("student"), async (req, res) => {
  res.json({ data: await enrollments.listForStudent(req.user!) });
});

enrollmentsRouter.get("/courses/:courseId/students", ...protect("instructor", "admin"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwnerOrAdmin(course, req.user!);
  res.json({ data: await enrollments.listStudents(course) });
});

enrollmentsRouter.get("/courses/:courseId/progress", ...protect("student"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertEnrolledStudent(course, req.user!);
  res.json({ data: await courseProgress(req.user!._id, course._id) });
});

enrollmentsRouter.post("/lessons/:lessonId/progress", ...protect("student"), validateBody(progressBody), async (req, res) => {
  res.json({ data: await enrollments.setLessonProgress(req.user!, oid(req.params.lessonId), req.body.completed) });
});
