import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { assertEnrolledStudent, isOwner, loadCourse, notify, paginate } from "../../shared/helpers.js";
import { Course, type CourseDoc } from "../courses/course.model.js";
import { Enrollment } from "../enrollments/enrollment.model.js";
import { User, type UserDoc } from "../users/user.model.js";
import { Assignment, Submission } from "./assessment.model.js";
import type { CreateAssignmentInput, GradeInput, SubmissionInput } from "./assignment.schemas.js";

// ---------- Presenters ----------

type SubmissionLike = {
  _id: unknown;
  assignmentId: unknown;
  studentId: unknown;
  textResponse?: string | null;
  fileUrl?: string | null;
  submittedAt: Date;
  isLate: boolean;
  status: string;
  version: number;
  grade?: { pointsAwarded?: number | null; feedback?: string | null; gradedAt?: Date | null } | null;
};

export const submissionDto = (s: SubmissionLike) => ({
  id: String(s._id),
  assignmentId: String(s.assignmentId),
  studentId: String(s.studentId),
  textResponse: s.textResponse,
  fileUrl: s.fileUrl,
  submittedAt: s.submittedAt,
  isLate: s.isLate,
  status: s.status,
  version: s.version,
  // The grade is only visible once an instructor has actually graded the work.
  grade: s.status === "graded" ? { pointsAwarded: s.grade?.pointsAwarded, feedback: s.grade?.feedback, gradedAt: s.grade?.gradedAt } : null,
});

export const assignmentDto = (a: {
  _id: unknown;
  courseId: unknown;
  title: string;
  instructions: string;
  dueAt: Date;
  maxPoints: number;
  allowResubmission: boolean;
}) => ({
  id: String(a._id),
  courseId: String(a.courseId),
  title: a.title,
  instructions: a.instructions,
  dueAt: a.dueAt,
  maxPoints: a.maxPoints,
  allowResubmission: a.allowResubmission,
});

// ---------- Use cases ----------

export async function createAssignment(course: CourseDoc, input: CreateAssignmentInput) {
  const assignment = await Assignment.create({ ...input, courseId: course._id });
  const enrolled = await Enrollment.find({ courseId: course._id }).select("studentId").lean();
  await Promise.all(
    enrolled.map((e) =>
      notify(e.studentId, "new_assignment", "New assignment", `"${assignment.title}" was added to ${course.title}.`, `/student/courses/${course.id}`),
    ),
  );
  return assignment;
}

export async function listForCourse(course: CourseDoc, user: UserDoc) {
  const assignments = await Assignment.find({ courseId: course._id }).sort({ dueAt: 1 }).lean();
  const mine = user.role === "student" ? await Submission.find({ studentId: user._id, courseId: course._id }).lean() : [];
  const byAssignment = new Map(mine.map((s) => [String(s.assignmentId), s]));
  return assignments.map((a) => ({
    ...assignmentDto(a),
    submission: byAssignment.has(String(a._id)) ? submissionDto(byAssignment.get(String(a._id))!) : null,
  }));
}

/** Every assignment across the student's enrolled courses, with their own submission status. */
export async function listForStudent(student: UserDoc) {
  const courseIds = (await Enrollment.find({ studentId: student._id }).select("courseId").lean()).map((e) => e.courseId);
  const [assignments, submissions, courses] = await Promise.all([
    Assignment.find({ courseId: { $in: courseIds } })
      .sort({ dueAt: 1 })
      .lean(),
    Submission.find({ studentId: student._id }).lean(),
    Course.find({ _id: { $in: courseIds } })
      .select("title")
      .lean(),
  ]);
  const titles = new Map(courses.map((c) => [String(c._id), c.title]));
  const byAssignment = new Map(submissions.map((s) => [String(s.assignmentId), s]));
  return assignments.map((a) => ({
    ...assignmentDto(a),
    course: titles.get(String(a.courseId)) ?? "",
    submission: byAssignment.has(String(a._id)) ? submissionDto(byAssignment.get(String(a._id))!) : null,
  }));
}

export async function submitWork(assignmentId: string, student: UserDoc, input: SubmissionInput) {
  const assignment = await Assignment.findById(assignmentId);
  if (!assignment) throw notFound("Assignment not found");
  const course = await loadCourse(assignment.courseId);
  await assertEnrolledStudent(course, student);
  if (course.status === "archived") throw badRequest("This course is archived");

  const now = new Date();
  const isLate = now > assignment.dueAt;
  const existing = await Submission.findOne({ assignmentId: assignment._id, studentId: student._id });
  let submission;
  if (existing) {
    if (!assignment.allowResubmission) throw conflict("This assignment does not allow resubmission");
    // A resubmission replaces the work, bumps the version and clears the old grade.
    existing.set({ ...input, submittedAt: now, isLate, status: "submitted", version: existing.version + 1, grade: undefined });
    submission = await existing.save();
  } else {
    try {
      submission = await Submission.create({ ...input, assignmentId: assignment._id, courseId: course._id, studentId: student._id, submittedAt: now, isLate });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict("You already submitted this assignment");
      throw e;
    }
  }
  await notify(
    course.instructorId,
    "new_submission",
    "New submission",
    `${student.name} submitted "${assignment.title}"${isLate ? " (late)" : ""}.`,
    "/instructor/submissions",
  );
  return submission;
}

export async function listSubmissionsForAssignment(assignmentId: string) {
  const submissions = await Submission.find({ assignmentId }).sort({ submittedAt: -1 }).lean();
  const users = await User.find({ _id: { $in: submissions.map((s) => s.studentId) } })
    .select("name")
    .lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  return submissions.map((s) => ({ ...submissionDto(s), studentName: names.get(String(s.studentId)) }));
}

/** Submissions across the instructor's own courses (admins see every course). */
export async function listForInstructor(user: UserDoc, query: Record<string, unknown>) {
  const { page, pageSize, skip } = paginate(query, 25);
  const courses = await Course.find(user.role === "admin" ? {} : { instructorId: user._id })
    .select("title")
    .lean();
  const filter: Record<string, unknown> = { courseId: { $in: courses.map((c) => c._id) } };
  if (query.status === "submitted" || query.status === "graded") filter.status = query.status;

  const [submissions, total] = await Promise.all([
    Submission.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(pageSize).lean(),
    Submission.countDocuments(filter),
  ]);
  const [users, assignments] = await Promise.all([
    User.find({ _id: { $in: submissions.map((s) => s.studentId) } })
      .select("name")
      .lean(),
    Assignment.find({ _id: { $in: submissions.map((s) => s.assignmentId) } }).lean(),
  ]);
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const byId = new Map(assignments.map((a) => [String(a._id), a]));
  const titles = new Map(courses.map((c) => [String(c._id), c.title]));
  return {
    items: submissions.map((s) => ({
      ...submissionDto(s),
      studentName: names.get(String(s.studentId)),
      assignmentTitle: byId.get(String(s.assignmentId))?.title,
      maxPoints: byId.get(String(s.assignmentId))?.maxPoints,
      course: titles.get(String(s.courseId)),
    })),
    page,
    pageSize,
    total,
  };
}

export async function gradeSubmission(submissionId: string, grader: UserDoc, input: GradeInput) {
  const submission = await Submission.findById(submissionId);
  if (!submission) throw notFound("Submission not found");
  // Instructors may only grade work from courses they own.
  if (grader.role === "instructor" && !isOwner(await loadCourse(submission.courseId), grader)) throw forbidden("You do not own this course");
  const assignment = await Assignment.findById(submission.assignmentId);
  if (!assignment) throw notFound("Assignment not found");
  if (input.pointsAwarded > assignment.maxPoints) throw badRequest(`Points cannot exceed ${assignment.maxPoints}`);

  submission.status = "graded";
  submission.grade = { pointsAwarded: input.pointsAwarded, feedback: input.feedback, gradedBy: grader._id, gradedAt: new Date() };
  await submission.save();
  await notify(
    submission.studentId,
    "assignment_graded",
    "Assignment graded",
    `"${assignment.title}" was graded: ${input.pointsAwarded}/${assignment.maxPoints}.`,
    "/student/grades",
  );
  return submission;
}
