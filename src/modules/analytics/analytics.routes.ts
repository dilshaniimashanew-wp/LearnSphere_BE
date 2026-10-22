import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { Assignment, Quiz, QuizAttempt, Submission } from "../assessments/assessment.model.js";
import { Course } from "../courses/course.model.js";
import { presentCourse } from "../courses/course.presenter.js";
import { Enrollment } from "../enrollments/enrollment.model.js";
import { courseProgress } from "../enrollments/progress.service.js";
import { Certificate } from "../platform/platform.model.js";
import { User } from "../users/user.model.js";

export const analyticsRouter = Router();

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** Platform-wide totals computed with server-side aggregation. */
analyticsRouter.get("/admin/analytics", authenticate, requireRole("admin"), async (_req, res) => {
  const [users, courses, enrollments, completed, pending, quizAgg, certificates] = await Promise.all([
    User.countDocuments(),
    Course.countDocuments({ status: "published" }),
    Enrollment.countDocuments(),
    Enrollment.countDocuments({ status: "completed" }),
    Course.countDocuments({ status: "pending_review" }),
    QuizAttempt.aggregate([{ $match: { status: "submitted" } }, { $group: { _id: null, attempts: { $sum: 1 }, passed: { $sum: { $cond: ["$passed", 1, 0] } } } }]),
    Certificate.countDocuments(),
  ]);
  const byRole = await User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]);
  res.json({
    data: {
      users,
      usersByRole: Object.fromEntries(byRole.map((r) => [r._id, r.count])),
      publishedCourses: courses,
      pendingCourses: pending,
      enrollments,
      completedEnrollments: completed,
      completionRate: pct(completed, enrollments),
      quizAttempts: quizAgg[0]?.attempts ?? 0,
      quizPassRate: pct(quizAgg[0]?.passed ?? 0, quizAgg[0]?.attempts ?? 0),
      certificates,
    },
  });
});

/** Instructor analytics are scoped to courses the instructor owns. */
analyticsRouter.get("/instructor/analytics", authenticate, requireRole("instructor"), async (req, res) => {
  const courses = await Course.find({ instructorId: req.user!._id });
  const courseIds = courses.map((c) => c._id);
  const [enrollments, completed, toGrade, quizAgg] = await Promise.all([
    Enrollment.countDocuments({ courseId: { $in: courseIds } }),
    Enrollment.countDocuments({ courseId: { $in: courseIds }, status: "completed" }),
    Submission.countDocuments({ courseId: { $in: courseIds }, status: "submitted" }),
    QuizAttempt.aggregate([
      { $match: { courseId: { $in: courseIds }, status: "submitted" } },
      { $group: { _id: null, avg: { $avg: { $cond: [{ $gt: ["$maxScore", 0] }, { $multiply: [{ $divide: ["$score", "$maxScore"] }, 100] }, 0] } } } },
    ]),
  ]);
  const perCourse = await Promise.all(
    courses.map(async (c) => {
      const [total, done] = await Promise.all([Enrollment.countDocuments({ courseId: c._id }), Enrollment.countDocuments({ courseId: c._id, status: "completed" })]);
      return { id: c.id, title: c.title, status: c.status, students: total, completion: pct(done, total) };
    }),
  );
  res.json({
    data: {
      courses: courses.length,
      pendingReview: courses.filter((c) => c.status === "pending_review").length,
      students: enrollments,
      toGrade,
      completionRate: pct(completed, enrollments),
      avgQuizScore: Math.round(quizAgg[0]?.avg ?? 0),
      perCourse,
    },
  });
});

/** Student dashboard summary: counts and upcoming work. */
analyticsRouter.get("/student/summary", authenticate, requireRole("student"), async (req, res) => {
  const enrollments = await Enrollment.find({ studentId: req.user!._id });
  const courseIds = enrollments.map((e) => e.courseId);
  const [assignments, submissions, quizzes, attempts] = await Promise.all([
    Assignment.find({ courseId: { $in: courseIds }, dueAt: { $gte: new Date() } }).sort({ dueAt: 1 }).lean(),
    Submission.find({ studentId: req.user!._id }).select("assignmentId").lean(),
    Quiz.find({ courseId: { $in: courseIds }, status: "published" }).lean(),
    QuizAttempt.find({ studentId: req.user!._id, passed: true }).select("quizId").lean(),
  ]);
  const submitted = new Set(submissions.map((s) => String(s.assignmentId)));
  const passed = new Set(attempts.map((a) => String(a.quizId)));
  const courses = await Course.find({ _id: { $in: courseIds } }).select("title").lean();
  const titles = new Map(courses.map((c) => [String(c._id), c.title]));

  const upcoming = [
    ...assignments.filter((a) => !submitted.has(String(a._id))).map((a) => ({ id: String(a._id), title: `Assignment: ${a.title}`, course: titles.get(String(a.courseId)) ?? "", due: a.dueAt, link: `/student/assignments` })),
    ...quizzes.filter((q) => !passed.has(String(q._id))).map((q) => ({ id: String(q._id), title: `Quiz: ${q.title}`, course: titles.get(String(q.courseId)) ?? "", due: null, link: `/student/courses/${q.courseId}` })),
  ];
  const active = enrollments.filter((e) => e.status === "active");
  res.json({
    data: {
      active: active.length,
      completed: enrollments.length - active.length,
      dueSoon: upcoming.length,
      upcoming: upcoming.slice(0, 8),
      progress: await Promise.all(
        active.map(async (e) => {
          const course = await Course.findById(e.courseId);
          const p = await courseProgress(req.user!._id, e.courseId);
          return { courseId: String(e.courseId), title: course?.title, progress: p.percent, course: course ? await presentCourse(course) : null };
        }),
      ),
    },
  });
});
