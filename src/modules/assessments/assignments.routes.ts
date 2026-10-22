import { Router } from "express";
import { httpUrl } from "../../shared/schemas.js";
import { z } from "zod";
import { protect } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { assertCanViewContent, assertEnrolledStudent, assertOwner, assertOwnerOrAdmin, isOwner, loadCourse, notify, oid, paginate } from "../../shared/helpers.js";
import { Course } from "../courses/course.model.js";
import { Enrollment } from "../enrollments/enrollment.model.js";
import { User } from "../users/user.model.js";
import { Assignment, Submission } from "./assessment.model.js";

export const assignmentsRouter = Router();

const assignmentBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    instructions: z.string().trim().min(5),
    dueAt: z.coerce.date(),
    maxPoints: z.number().int().min(1).max(1000).default(100),
    allowResubmission: z.boolean().default(false),
  })
  .strict();

const submissionBody = z
  .object({ textResponse: z.string().trim().max(10000).optional(), fileUrl: httpUrl.optional() })
  .strict()
  .refine((v) => v.textResponse || v.fileUrl, { message: "Provide a written response or a file link" });

const gradeBody = z.object({ pointsAwarded: z.number().min(0), feedback: z.string().trim().max(2000).default("") }).strict();

const submissionDto = (s: { _id: unknown; assignmentId: unknown; studentId: unknown; textResponse?: string | null; fileUrl?: string | null; submittedAt: Date; isLate: boolean; status: string; version: number; grade?: { pointsAwarded?: number | null; feedback?: string | null; gradedAt?: Date | null } | null }) => ({
  id: String(s._id),
  assignmentId: String(s.assignmentId),
  studentId: String(s.studentId),
  textResponse: s.textResponse,
  fileUrl: s.fileUrl,
  submittedAt: s.submittedAt,
  isLate: s.isLate,
  status: s.status,
  version: s.version,
  grade: s.status === "graded" ? { pointsAwarded: s.grade?.pointsAwarded, feedback: s.grade?.feedback, gradedAt: s.grade?.gradedAt } : null,
});

const assignmentDto = (a: { _id: unknown; courseId: unknown; title: string; instructions: string; dueAt: Date; maxPoints: number; allowResubmission: boolean }) => ({
  id: String(a._id),
  courseId: String(a.courseId),
  title: a.title,
  instructions: a.instructions,
  dueAt: a.dueAt,
  maxPoints: a.maxPoints,
  allowResubmission: a.allowResubmission,
});

// ---------- Instructor: create ----------
assignmentsRouter.post("/courses/:courseId/assignments", ...protect("instructor"), validateBody(assignmentBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const assignment = await Assignment.create({ ...req.body, courseId: course._id });
  const enrolled = await Enrollment.find({ courseId: course._id }).select("studentId").lean();
  await Promise.all(enrolled.map((e) => notify(e.studentId, "new_assignment", "New assignment", `"${assignment.title}" was added to ${course.title}.`, `/student/courses/${course.id}`)));
  res.status(201).json({ data: assignmentDto(assignment), message: "Assignment created" });
});

assignmentsRouter.get("/courses/:courseId/assignments", ...protect(), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertCanViewContent(course, req.user!);
  const assignments = await Assignment.find({ courseId: course._id }).sort({ dueAt: 1 }).lean();
  const mine = req.user!.role === "student" ? await Submission.find({ studentId: req.user!._id, courseId: course._id }).lean() : [];
  const byAssignment = new Map(mine.map((s) => [String(s.assignmentId), s]));
  res.json({ data: assignments.map((a) => ({ ...assignmentDto(a), submission: byAssignment.has(String(a._id)) ? submissionDto(byAssignment.get(String(a._id))!) : null })) });
});

// ---------- Student: everything due across enrolled courses ----------
assignmentsRouter.get("/assignments/me", ...protect("student"), async (req, res) => {
  const enrollments = await Enrollment.find({ studentId: req.user!._id }).select("courseId").lean();
  const courseIds = enrollments.map((e) => e.courseId);
  const [assignments, submissions, courses] = await Promise.all([
    Assignment.find({ courseId: { $in: courseIds } }).sort({ dueAt: 1 }).lean(),
    Submission.find({ studentId: req.user!._id }).lean(),
    Course.find({ _id: { $in: courseIds } }).select("title").lean(),
  ]);
  const titles = new Map(courses.map((c) => [String(c._id), c.title]));
  const byAssignment = new Map(submissions.map((s) => [String(s.assignmentId), s]));
  res.json({
    data: assignments.map((a) => ({
      ...assignmentDto(a),
      course: titles.get(String(a.courseId)) ?? "",
      submission: byAssignment.has(String(a._id)) ? submissionDto(byAssignment.get(String(a._id))!) : null,
    })),
  });
});

assignmentsRouter.get("/assignments/:assignmentId", ...protect(), async (req, res) => {
  const assignment = await Assignment.findById(oid(req.params.assignmentId));
  if (!assignment) throw notFound("Assignment not found");
  await assertCanViewContent(await loadCourse(assignment.courseId), req.user!);
  res.json({ data: assignmentDto(assignment) });
});

assignmentsRouter.post("/assignments/:assignmentId/submissions", ...protect("student"), validateBody(submissionBody), async (req, res) => {
  const assignment = await Assignment.findById(oid(req.params.assignmentId));
  if (!assignment) throw notFound("Assignment not found");
  const course = await loadCourse(assignment.courseId);
  await assertEnrolledStudent(course, req.user!);
  if (course.status === "archived") throw badRequest("This course is archived");

  const now = new Date();
  const isLate = now > assignment.dueAt;
  const existing = await Submission.findOne({ assignmentId: assignment._id, studentId: req.user!._id });
  let submission;
  if (existing) {
    if (!assignment.allowResubmission) throw conflict("This assignment does not allow resubmission");
    existing.set({ ...req.body, submittedAt: now, isLate, status: "submitted", version: existing.version + 1, grade: undefined });
    submission = await existing.save();
  } else {
    try {
      submission = await Submission.create({ ...req.body, assignmentId: assignment._id, courseId: course._id, studentId: req.user!._id, submittedAt: now, isLate });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict("You already submitted this assignment");
      throw e;
    }
  }
  await notify(course.instructorId, "new_submission", "New submission", `${req.user!.name} submitted "${assignment.title}"${isLate ? " (late)" : ""}.`, "/instructor/submissions");
  res.status(201).json({ data: submissionDto(submission), message: "Submitted" });
});

// ---------- Instructor: review & grade ----------
assignmentsRouter.get("/assignments/:assignmentId/submissions", ...protect("instructor", "admin"), async (req, res) => {
  const assignment = await Assignment.findById(oid(req.params.assignmentId));
  if (!assignment) throw notFound("Assignment not found");
  assertOwnerOrAdmin(await loadCourse(assignment.courseId), req.user!);
  const submissions = await Submission.find({ assignmentId: assignment._id }).sort({ submittedAt: -1 }).lean();
  const users = await User.find({ _id: { $in: submissions.map((s) => s.studentId) } }).select("name").lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  res.json({ data: submissions.map((s) => ({ ...submissionDto(s), studentName: names.get(String(s.studentId)) })) });
});

/** All submissions across the instructor's own courses (admins see every course). */
assignmentsRouter.get("/instructor/submissions", ...protect("instructor", "admin"), async (req, res) => {
  const { page, pageSize, skip } = paginate(req.query, 25);
  const courseFilter = req.user!.role === "admin" ? {} : { instructorId: req.user!._id };
  const courses = await Course.find(courseFilter).select("title").lean();
  const filter: Record<string, unknown> = { courseId: { $in: courses.map((c) => c._id) } };
  if (req.query.status === "submitted" || req.query.status === "graded") filter.status = req.query.status;

  const [submissions, total] = await Promise.all([Submission.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(pageSize).lean(), Submission.countDocuments(filter)]);
  const [users, assignments] = await Promise.all([
    User.find({ _id: { $in: submissions.map((s) => s.studentId) } }).select("name").lean(),
    Assignment.find({ _id: { $in: submissions.map((s) => s.assignmentId) } }).lean(),
  ]);
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const aMap = new Map(assignments.map((a) => [String(a._id), a]));
  const titles = new Map(courses.map((c) => [String(c._id), c.title]));
  res.json({
    data: {
      items: submissions.map((s) => ({
        ...submissionDto(s),
        studentName: names.get(String(s.studentId)),
        assignmentTitle: aMap.get(String(s.assignmentId))?.title,
        maxPoints: aMap.get(String(s.assignmentId))?.maxPoints,
        course: titles.get(String(s.courseId)),
      })),
      page,
      pageSize,
      total,
    },
  });
});

assignmentsRouter.patch("/submissions/:submissionId/grade", ...protect("instructor", "admin"), validateBody(gradeBody), async (req, res) => {
  const submission = await Submission.findById(oid(req.params.submissionId));
  if (!submission) throw notFound("Submission not found");
  const course = await loadCourse(submission.courseId);
  // Instructors may only grade submissions from courses they own.
  if (req.user!.role === "instructor" && !isOwner(course, req.user!)) throw forbidden("You do not own this course");
  const assignment = await Assignment.findById(submission.assignmentId);
  if (!assignment) throw notFound("Assignment not found");
  const { pointsAwarded, feedback } = req.body as z.infer<typeof gradeBody>;
  if (pointsAwarded > assignment.maxPoints) throw badRequest(`Points cannot exceed ${assignment.maxPoints}`);

  submission.status = "graded";
  submission.grade = { pointsAwarded, feedback, gradedBy: req.user!._id, gradedAt: new Date() };
  await submission.save();
  await notify(submission.studentId, "assignment_graded", "Assignment graded", `"${assignment.title}" was graded: ${pointsAwarded}/${assignment.maxPoints}.`, "/student/grades");
  res.json({ data: submissionDto(submission), message: "Graded" });
});
