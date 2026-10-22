import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { Quiz, QuizAttempt } from "../assessments/assessment.model.js";
import { Course, Lesson } from "../courses/course.model.js";
import { Certificate } from "../platform/platform.model.js";
import { notify } from "../../shared/helpers.js";
import { Enrollment, LessonProgress } from "./enrollment.model.js";

/**
 * Completion rule (single source of truth):
 * every required lesson is complete AND every published quiz has at least one passing attempt.
 * Progress percentages are always computed here on the server from canonical records.
 */
export async function courseProgress(studentId: Types.ObjectId, courseId: Types.ObjectId) {
  const [lessons, done, quizzes] = await Promise.all([
    Lesson.find({ courseId, isRequired: true }).select("_id").lean(),
    LessonProgress.find({ studentId, courseId }).select("lessonId").lean(),
    Quiz.find({ courseId, status: "published" }).select("_id").lean(),
  ]);
  const doneIds = new Set(done.map((d) => String(d.lessonId)));
  const requiredDone = lessons.filter((l) => doneIds.has(String(l._id))).length;
  const passedQuizIds = new Set(
    (
      await QuizAttempt.find({ studentId, courseId, passed: true, quizId: { $in: quizzes.map((q) => q._id) } })
        .select("quizId")
        .lean()
    ).map((a) => String(a.quizId)),
  );
  const percent = lessons.length ? Math.round((requiredDone / lessons.length) * 100) : 0;
  const complete = lessons.length > 0 && requiredDone === lessons.length && passedQuizIds.size === quizzes.length;
  return {
    percent,
    completedLessonIds: [...doneIds],
    requiredLessons: lessons.length,
    completedRequiredLessons: requiredDone,
    quizzes: { total: quizzes.length, passed: passedQuizIds.size },
    complete,
  };
}

export const newCertificateCode = () => `LS-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;

/** Marks the enrollment complete and issues one certificate, exactly once, when the rule is satisfied. */
export async function evaluateCompletion(studentId: Types.ObjectId, courseId: Types.ObjectId) {
  const progress = await courseProgress(studentId, courseId);
  if (!progress.complete) return progress;

  // Atomic state transition: only the first caller flips active -> completed.
  const flipped = await Enrollment.findOneAndUpdate({ studentId, courseId, status: "active" }, { status: "completed", completedAt: new Date() });
  if (flipped) {
    const course = await Course.findById(courseId).select("title").lean();
    await Certificate.updateOne({ studentId, courseId }, { $setOnInsert: { certificateCode: newCertificateCode(), issuedAt: new Date() } }, { upsert: true });
    await notify(
      studentId,
      "course_completed",
      "Course completed",
      `You completed ${course?.title ?? "your course"}. Your certificate is ready.`,
      "/student/certificates",
    );
  }
  return progress;
}
