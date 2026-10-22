import { Router } from "express";
import { z } from "zod";
import { authenticate, optionalAuth, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { forbidden, notFound } from "../../shared/errors.js";
import { assertCanViewContent, assertEnrolledStudent, assertOwner, isOwner, loadCourse, notify, oid } from "../../shared/helpers.js";
import { Enrollment } from "../enrollments/enrollment.model.js";
import { User } from "../users/user.model.js";
import { Announcement, Review } from "../platform/platform.model.js";

export const engagementRouter = Router();

const announcementBody = z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(4000) }).strict();
const reviewBody = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() }).strict();

// ---------- Announcements ----------
engagementRouter.get("/courses/:courseId/announcements", authenticate, async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertCanViewContent(course, req.user!);
  const items = await Announcement.find({ courseId: course._id }).sort({ createdAt: -1 }).limit(50).lean();
  const authors = await User.find({ _id: { $in: items.map((a) => a.authorId) } }).select("name").lean();
  const names = new Map(authors.map((a) => [String(a._id), a.name]));
  res.json({ data: items.map((a) => ({ id: String(a._id), title: a.title, body: a.body, author: names.get(String(a.authorId)) ?? "Instructor", createdAt: a.createdAt })) });
});

engagementRouter.post("/courses/:courseId/announcements", authenticate, requireRole("instructor"), validateBody(announcementBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const a = await Announcement.create({ ...req.body, courseId: course._id, authorId: req.user!._id });
  const students = await Enrollment.find({ courseId: course._id }).select("studentId").lean();
  await Promise.all(students.map((s) => notify(s.studentId, "announcement", `Announcement: ${a.title}`, `${course.title}: ${a.body.slice(0, 140)}`, `/student/courses/${course.id}`)));
  res.status(201).json({ data: { id: a.id, title: a.title, body: a.body, createdAt: a.createdAt }, message: "Announcement posted" });
});

engagementRouter.delete("/announcements/:announcementId", authenticate, requireRole("instructor"), async (req, res) => {
  const a = await Announcement.findById(oid(req.params.announcementId));
  if (!a) throw notFound("Announcement not found");
  assertOwner(await loadCourse(a.courseId), req.user!);
  await a.deleteOne();
  res.json({ message: "Announcement deleted" });
});

// ---------- Reviews (only students enrolled in the course may review it) ----------
engagementRouter.get("/courses/:courseId/reviews", optionalAuth, async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  if (course.status !== "published" && !(req.user && (req.user.role === "admin" || isOwner(course, req.user)))) throw notFound("Course not found");
  const reviews = await Review.find({ courseId: course._id }).sort({ updatedAt: -1 }).limit(100).lean();
  const students = await User.find({ _id: { $in: reviews.map((r) => r.studentId) } }).select("name").lean();
  const names = new Map(students.map((s) => [String(s._id), s.name]));
  const average = reviews.length ? Math.round((reviews.reduce((n, r) => n + r.rating, 0) / reviews.length) * 10) / 10 : 0;
  const mine = req.user ? reviews.find((r) => r.studentId.equals(req.user!._id)) : undefined;
  res.json({
    data: {
      average,
      count: reviews.length,
      canReview: !!req.user && req.user.role === "student" && !!(await Enrollment.exists({ studentId: req.user._id, courseId: course._id })),
      mine: mine ? { rating: mine.rating, comment: mine.comment } : null,
      items: reviews.map((r) => ({ id: String(r._id), name: names.get(String(r.studentId)) ?? "Student", rating: r.rating, comment: r.comment, updatedAt: r.updatedAt })),
    },
  });
});

engagementRouter.put("/courses/:courseId/reviews", authenticate, requireRole("student"), validateBody(reviewBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  if (course.status !== "published") throw forbidden("Only published courses can be reviewed");
  await assertEnrolledStudent(course, req.user!);
  // Upsert on the unique (course, student) index: a second submit edits the same review.
  await Review.updateOne({ courseId: course._id, studentId: req.user!._id }, { $set: { rating: req.body.rating, comment: req.body.comment ?? "" } }, { upsert: true });
  res.json({ message: "Review saved" });
});

engagementRouter.delete("/courses/:courseId/reviews/mine", authenticate, requireRole("student"), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await Review.deleteOne({ courseId: course._id, studentId: req.user!._id });
  res.json({ message: "Review removed" });
});
