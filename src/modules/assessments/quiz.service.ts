import type { Types } from "mongoose";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { assertCanViewContent, assertEnrolledStudent, isOwner, loadCourse } from "../../shared/helpers.js";
import type { CourseDoc } from "../courses/course.model.js";
import { evaluateCompletion } from "../enrollments/progress.service.js";
import type { UserDoc } from "../users/user.model.js";
import { Quiz, QuizAttempt, Question } from "./assessment.model.js";
import type { AnswerInput, QuestionInput } from "./quiz.schemas.js";

/** Seconds of tolerance for network delay when checking the time limit. */
export const GRACE_SECONDS = 10;
const LETTERS = "abcdefghij";

// ---------- Pure helpers (unit tested without a database) ----------

/** Validates questions and converts them to stored documents. Option ids are letters: a, b, c... */
export function buildQuestionDocs(questions: QuestionInput[]) {
  return questions.map((q, order) => {
    const texts = q.type === "true_false" ? ["True", "False"] : q.options;
    if (texts.length < 2) throw badRequest(`Question ${order + 1} needs at least two options`);
    if (q.correctIndex >= texts.length) throw badRequest(`Question ${order + 1} has an invalid correct answer`);
    return {
      id: q.id,
      doc: {
        type: q.type,
        prompt: q.prompt,
        options: texts.map((text, i) => ({ id: LETTERS[i], text })),
        correctOptionId: LETTERS[q.correctIndex],
        points: q.points,
        order,
      },
    };
  });
}

export interface GradableQuestion {
  _id: Types.ObjectId;
  points: number;
  correctOptionId: string;
}

/** Scores answers against the answer key. Unanswered or unknown questions earn 0. */
export function gradeAnswers(questions: GradableQuestion[], answers: Pick<AnswerInput, "questionId" | "optionId">[]) {
  const chosen = new Map(answers.map((a) => [a.questionId, a.optionId]));
  let score = 0;
  let maxScore = 0;
  const graded = questions.map((q) => {
    const optionId = chosen.get(String(q._id));
    const correct = optionId !== undefined && optionId === q.correctOptionId;
    maxScore += q.points;
    if (correct) score += q.points;
    return { questionId: q._id, optionId: optionId ?? "", correct, points: correct ? q.points : 0 };
  });
  return { graded, score, maxScore };
}

export const isPassing = (score: number, maxScore: number, passMark: number) => maxScore > 0 && (score / maxScore) * 100 >= passMark;
export const percentOf = (score: number, maxScore: number) => Math.round((score / (maxScore || 1)) * 100);
export const deadlineOf = (startedAt: Date, timeLimitSeconds: number) => new Date(startedAt.getTime() + timeLimitSeconds * 1000);

/** Student-safe question shape: correct answers are never included. */
export const toPublicQuestion = (q: { _id: unknown; type: string; prompt: string; options: { id?: string | null; text?: string | null }[]; points: number }) => ({
  id: String(q._id),
  type: q.type,
  prompt: q.prompt,
  options: q.options.map((o) => ({ id: o.id, text: o.text })),
  points: q.points,
});

// ---------- Instructor use cases ----------

type QuizSettings = { title: string; instructions?: string; timeLimitSeconds: number; passMark: number; maxAttempts: number };

export async function createQuiz(course: CourseDoc, settings: QuizSettings, questions: QuestionInput[]) {
  const docs = buildQuestionDocs(questions);
  const quiz = await Quiz.create({ ...settings, courseId: course._id, status: "published" });
  await Question.insertMany(docs.map((d) => ({ ...d.doc, quizId: quiz._id })));
  return { quiz, questionCount: docs.length };
}

/** Edits in place. Existing questions keep their id so past attempts stay meaningful. */
export async function updateQuiz(quizId: string, settings: QuizSettings, questions: QuestionInput[]) {
  const quiz = await Quiz.findById(quizId);
  if (!quiz) throw notFound("Quiz not found");
  const built = buildQuestionDocs(questions);

  const existingIds = new Set((await Question.find({ quizId: quiz._id }).select("_id").lean()).map((q) => String(q._id)));
  if (built.some((b) => b.id && !existingIds.has(b.id))) throw badRequest("Unknown question id");
  const keep = new Set(built.flatMap((b) => (b.id ? [b.id] : [])));

  quiz.set(settings);
  await quiz.save();
  await Question.deleteMany({ quizId: quiz._id, _id: { $in: [...existingIds].filter((id) => !keep.has(id)) } });
  for (const b of built) {
    if (b.id) await Question.updateOne({ _id: b.id, quizId: quiz._id }, { $set: b.doc });
    else await Question.create({ ...b.doc, quizId: quiz._id });
  }
  return { quiz, questionCount: built.length };
}

// ---------- Reading ----------

export async function listQuizzes(course: CourseDoc, user: UserDoc) {
  const quizzes = await Quiz.find({ courseId: course._id, status: "published" }).sort({ createdAt: 1 }).lean();
  return Promise.all(
    quizzes.map(async (q) => {
      const base = {
        id: String(q._id),
        title: q.title,
        instructions: q.instructions,
        timeLimitSeconds: q.timeLimitSeconds,
        passMark: q.passMark,
        maxAttempts: q.maxAttempts,
        questionCount: await Question.countDocuments({ quizId: q._id }),
      };
      if (user.role !== "student") return base;
      const attempts = await QuizAttempt.find({ quizId: q._id, studentId: user._id }).sort({ attemptNumber: 1 }).lean();
      const submitted = attempts.filter((a) => a.status === "submitted");
      return {
        ...base,
        attemptsUsed: attempts.length,
        passed: submitted.some((a) => a.passed),
        bestScore: submitted.length ? Math.max(...submitted.map((a) => percentOf(a.score, a.maxScore))) : null,
        latestAttemptId: submitted.length ? String(submitted[submitted.length - 1]._id) : null,
      };
    }),
  );
}

/** A quiz with its questions. Only the owner and admins receive the answer key. */
export async function getQuizDetail(quizId: string, user: UserDoc) {
  const quiz = await Quiz.findById(quizId);
  if (!quiz || quiz.status !== "published") throw notFound("Quiz not found");
  const course = await loadCourse(quiz.courseId);
  await assertCanViewContent(course, user);
  const privileged = user.role === "admin" || isOwner(course, user);
  const questions = await Question.find({ quizId: quiz._id }).select(privileged ? "+correctOptionId" : "").sort({ order: 1 }).lean();
  return {
    quiz,
    questions: questions.map((q) => ({ ...toPublicQuestion(q), ...(privileged ? { correctOptionId: (q as { correctOptionId?: string }).correctOptionId } : {}) })),
  };
}

// ---------- Student attempts ----------

async function loadKey(quizId: Types.ObjectId) {
  return (await Question.find({ quizId }).select("+correctOptionId").lean()) as unknown as (GradableQuestion & { type: string; prompt: string; options: { id: string; text: string }[]; order: number })[];
}

/** Starts a new attempt, or resumes the one still inside its time limit. */
export async function startAttempt(quizId: string, student: UserDoc) {
  const quiz = await Quiz.findById(quizId);
  if (!quiz || quiz.status !== "published") throw notFound("Quiz not found");
  const course = await loadCourse(quiz.courseId);
  await assertEnrolledStudent(course, student);

  const questions = await Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean();
  const present = (attempt: { _id: unknown; attemptNumber: number; startedAt: Date }) => ({
    attemptId: String(attempt._id),
    attemptNumber: attempt.attemptNumber,
    startedAt: attempt.startedAt,
    deadline: deadlineOf(attempt.startedAt, quiz.timeLimitSeconds),
    timeLimitSeconds: quiz.timeLimitSeconds,
    questions: questions.map(toPublicQuestion),
  });

  const open = await QuizAttempt.findOne({ quizId: quiz._id, studentId: student._id, status: "in_progress" });
  if (open) {
    if (Date.now() <= deadlineOf(open.startedAt, quiz.timeLimitSeconds).getTime() + GRACE_SECONDS * 1000) return present(open);
    // The time ran out without a submit: close it with a score of 0 and let them start a new one if attempts remain.
    const { graded, score, maxScore } = gradeAnswers(await loadKey(quiz._id), []);
    await QuizAttempt.updateOne({ _id: open._id, status: "in_progress" }, { status: "submitted", submittedAt: new Date(), answers: graded, score, maxScore, passed: false });
  }

  const used = await QuizAttempt.countDocuments({ quizId: quiz._id, studentId: student._id });
  if (used >= quiz.maxAttempts) throw forbidden("You have used all attempts for this quiz");
  try {
    return present(await QuizAttempt.create({ quizId: quiz._id, courseId: course._id, studentId: student._id, attemptNumber: used + 1 }));
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict("An attempt is already being created. Try again.");
    throw e;
  }
}

export async function submitAttempt(attemptId: string, student: UserDoc, answers: AnswerInput[]) {
  // Atomic claim: only one request can move an attempt out of "in_progress", so a double
  // submit (or a retry) can never be graded twice.
  const attempt = await QuizAttempt.findOneAndUpdate({ _id: attemptId, studentId: student._id, status: "in_progress" }, { status: "submitted", submittedAt: new Date() }, { returnDocument: "after" });
  if (!attempt) {
    if (!(await QuizAttempt.exists({ _id: attemptId, studentId: student._id }))) throw notFound("Attempt not found");
    throw conflict("This attempt was already submitted");
  }
  const quiz = await Quiz.findById(attempt.quizId);
  if (!quiz) throw notFound("Quiz not found");

  const late = attempt.submittedAt!.getTime() > deadlineOf(attempt.startedAt, quiz.timeLimitSeconds).getTime() + GRACE_SECONDS * 1000;
  const { graded, score, maxScore } = gradeAnswers(await loadKey(quiz._id), late ? [] : answers);
  const passed = !late && isPassing(score, maxScore, quiz.passMark);
  await QuizAttempt.updateOne({ _id: attempt._id }, { answers: graded, score, maxScore, passed });
  if (passed) await evaluateCompletion(student._id, attempt.courseId);

  if (late) throw new AppError(409, "TIME_EXPIRED", "The time limit was exceeded, so this attempt scored 0");
  return { attemptId, score, maxScore, percent: percentOf(score, maxScore), passed };
}

export async function getAttemptResult(attemptId: string, user: UserDoc) {
  const attempt = await QuizAttempt.findById(attemptId);
  if (!attempt || attempt.status !== "submitted") throw notFound("Result not found");
  const [quiz, course] = await Promise.all([Quiz.findById(attempt.quizId), loadCourse(attempt.courseId)]);
  if (!attempt.studentId.equals(user._id) && user.role !== "admin" && !isOwner(course, user)) throw forbidden();

  const questions = await loadKey(attempt.quizId);
  const byQuestion = new Map(attempt.answers.map((a) => [String(a.questionId), a]));
  return {
    attemptId: attempt.id,
    quizTitle: quiz?.title,
    score: attempt.score,
    maxScore: attempt.maxScore,
    percent: percentOf(attempt.score, attempt.maxScore),
    passMark: quiz?.passMark,
    passed: attempt.passed,
    submittedAt: attempt.submittedAt,
    questions: questions
      .sort((a, b) => a.order - b.order)
      .map((q) => {
        const a = byQuestion.get(String(q._id));
        return { ...toPublicQuestion(q), chosenOptionId: a?.optionId || null, correctOptionId: q.correctOptionId, isCorrect: !!a?.correct };
      }),
  };
}
