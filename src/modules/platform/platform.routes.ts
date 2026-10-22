import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { notFound } from "../../shared/errors.js";
import { oid, paginate } from "../../shared/helpers.js";
import { Quiz, QuizAttempt, Submission, Assignment } from "../assessments/assessment.model.js";
import { Course } from "../courses/course.model.js";
import { User } from "../users/user.model.js";
import { Certificate, Notification } from "./platform.model.js";

export const platformRouter = Router();

// ---------- Certificates ----------
platformRouter.get("/certificates/me", authenticate, requireRole("student"), async (req, res) => {
  const certs = await Certificate.find({ studentId: req.user!._id, revokedAt: { $exists: false } })
    .sort({ issuedAt: -1 })
    .lean();
  const courses = await Course.find({ _id: { $in: certs.map((c) => c.courseId) } })
    .select("title")
    .lean();
  const titles = new Map(courses.map((c) => [String(c._id), c.title]));
  res.json({
    data: certs.map((c) => ({ id: String(c._id), course: titles.get(String(c.courseId)) ?? "Course", code: c.certificateCode, issuedAt: c.issuedAt })),
  });
});

// Public: exposes only the minimum needed to verify a certificate.
platformRouter.get("/certificates/verify/:code", async (req, res) => {
  const cert = await Certificate.findOne({ certificateCode: String(req.params.code).trim().toUpperCase(), revokedAt: { $exists: false } }).lean();
  if (!cert) throw notFound("No valid certificate found");
  const [student, course] = await Promise.all([User.findById(cert.studentId).select("name").lean(), Course.findById(cert.courseId).select("title").lean()]);
  res.json({ data: { studentName: student?.name ?? "Student", courseTitle: course?.title ?? "Course", issuedAt: cert.issuedAt } });
});

// ---------- Notifications ----------
platformRouter.get("/notifications", authenticate, async (req, res) => {
  const { page, pageSize, skip } = paginate(req.query, 30);
  const filter = { recipientId: req.user!._id };
  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, readAt: { $exists: false } }),
  ]);
  res.json({
    data: {
      items: items.map((n) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.readAt, createdAt: n.createdAt })),
      page,
      pageSize,
      total,
      unread,
    },
  });
});

// Registered before "/:id/read" so "read-all" is not parsed as an id.
platformRouter.patch("/notifications/read-all", authenticate, async (req, res) => {
  await Notification.updateMany({ recipientId: req.user!._id, readAt: { $exists: false } }, { readAt: new Date() });
  res.json({ message: "All notifications marked as read" });
});

platformRouter.patch("/notifications/:notificationId/read", authenticate, async (req, res) => {
  const result = await Notification.updateOne({ _id: oid(req.params.notificationId), recipientId: req.user!._id }, { readAt: new Date() });
  if (result.matchedCount === 0) throw notFound("Notification not found");
  res.json({ message: "Marked as read" });
});

// ---------- Student grades (quiz results + graded assignments) ----------
platformRouter.get("/grades/me", authenticate, requireRole("student"), async (req, res) => {
  const [attempts, submissions] = await Promise.all([
    QuizAttempt.find({ studentId: req.user!._id, status: "submitted" }).sort({ submittedAt: -1 }).lean(),
    Submission.find({ studentId: req.user!._id }).sort({ submittedAt: -1 }).lean(),
  ]);
  const [quizzes, assignments] = await Promise.all([
    Quiz.find({ _id: { $in: attempts.map((a) => a.quizId) } })
      .select("title courseId")
      .lean(),
    Assignment.find({ _id: { $in: submissions.map((s) => s.assignmentId) } })
      .select("title courseId maxPoints")
      .lean(),
  ]);
  const courses = await Course.find({ _id: { $in: [...quizzes.map((q) => q.courseId), ...assignments.map((a) => a.courseId)] } })
    .select("title")
    .lean();
  const courseTitle = new Map(courses.map((c) => [String(c._id), c.title]));
  const quizById = new Map(quizzes.map((q) => [String(q._id), q]));
  const assignmentById = new Map(assignments.map((a) => [String(a._id), a]));

  const items = [
    ...attempts.map((a) => {
      const q = quizById.get(String(a.quizId));
      return {
        id: String(a._id),
        kind: "quiz" as const,
        item: `Quiz: ${q?.title ?? "Quiz"}`,
        course: courseTitle.get(String(q?.courseId)) ?? "",
        score: `${a.score} / ${a.maxScore}`,
        passed: a.passed,
        date: a.submittedAt,
      };
    }),
    ...submissions
      .filter((s) => s.status === "graded")
      .map((s) => {
        const a = assignmentById.get(String(s.assignmentId));
        return {
          id: String(s._id),
          kind: "assignment" as const,
          item: a?.title ?? "Assignment",
          course: courseTitle.get(String(a?.courseId)) ?? "",
          score: `${s.grade?.pointsAwarded ?? 0} / ${a?.maxPoints ?? 0}`,
          passed: (s.grade?.pointsAwarded ?? 0) >= (a?.maxPoints ?? 1) * 0.5,
          feedback: s.grade?.feedback,
          date: s.grade?.gradedAt,
        };
      }),
  ];
  res.json({ data: items });
});
