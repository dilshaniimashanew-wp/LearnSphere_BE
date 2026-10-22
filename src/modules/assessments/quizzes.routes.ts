import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { assertCanViewContent, assertEnrolledStudent, assertOwner, isOwner, loadCourse, oid } from "../../shared/helpers.js";
import { evaluateCompletion } from "../enrollments/progress.service.js";
import { Quiz, QuizAttempt, Question } from "./assessment.model.js";

export const quizzesRouter = Router();
quizzesRouter.use(authenticate);

const GRACE_SECONDS = 10;
const letters = "abcdefghij";

const quizBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    instructions: z.string().trim().max(1000).optional(),
    timeLimitSeconds: z.number().int().min(30).max(10800).default(900),
    passMark: z.number().int().min(1).max(100).default(60),
    maxAttempts: z.number().int().min(1).max(20).default(3),
    questions: z
      .array(
        z
          .object({
            type: z.enum(["multiple_choice", "true_false"]),
            prompt: z.string().trim().min(3),
            options: z.array(z.string().trim().min(1)).max(8).default([]),
            correctIndex: z.number().int().min(0),
            points: z.number().int().min(1).max(100).default(1),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const updateQuizBody = quizBody.extend({
  questions: z
    .array(
      z
        .object({
          id: z.string().optional(), // present for an existing question, absent for a new one
          type: z.enum(["multiple_choice", "true_false"]),
          prompt: z.string().trim().min(3),
          options: z.array(z.string().trim().min(1)).max(8).default([]),
          correctIndex: z.number().int().min(0),
          points: z.number().int().min(1).max(100).default(1),
        })
        .strict(),
    )
    .min(1)
    .max(100),
});

const submitBody = z.object({ answers: z.array(z.object({ questionId: z.string(), optionId: z.string() }).strict()).max(200) }).strict();

/** Student-safe question shape: correct answers are never included. */
const publicQuestion = (q: { _id: unknown; type: string; prompt: string; options: { id?: string | null; text?: string | null }[]; points: number }) => ({
  id: String(q._id),
  type: q.type,
  prompt: q.prompt,
  options: q.options.map((o) => ({ id: o.id, text: o.text })),
  points: q.points,
});

// ---------- Instructor: build a quiz ----------
quizzesRouter.post("/courses/:courseId/quizzes", requireRole("instructor"), validateBody(quizBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const { questions, ...settings } = req.body as z.infer<typeof quizBody>;

  const docs = questions.map((q, order) => {
    const texts = q.type === "true_false" ? ["True", "False"] : q.options;
    if (texts.length < 2) throw badRequest(`Question ${order + 1} needs at least two options`);
    if (q.correctIndex >= texts.length) throw badRequest(`Question ${order + 1} has an invalid correct answer`);
    return {
      type: q.type,
      prompt: q.prompt,
      options: texts.map((text, i) => ({ id: letters[i], text })),
      correctOptionId: letters[q.correctIndex],
      points: q.points,
      order,
    };
  });

  const quiz = await Quiz.create({ ...settings, courseId: course._id, status: "published" });
  await Question.insertMany(docs.map((d) => ({ ...d, quizId: quiz._id })));
  res.status(201).json({ data: { id: quiz.id, title: quiz.title, questionCount: docs.length }, message: "Quiz created" });
});

/** Edit a quiz in place. Existing questions keep their id so past attempts stay meaningful. */
quizzesRouter.put("/quizzes/:quizId", requireRole("instructor"), validateBody(updateQuizBody), async (req, res) => {
  const quiz = await Quiz.findById(oid(req.params.quizId));
  if (!quiz) throw notFound("Quiz not found");
  assertOwner(await loadCourse(quiz.courseId), req.user!);
  const { questions, ...settings } = req.body as z.infer<typeof updateQuizBody>;

  const built = questions.map((q, order) => {
    const texts = q.type === "true_false" ? ["True", "False"] : q.options;
    if (texts.length < 2) throw badRequest(`Question ${order + 1} needs at least two options`);
    if (q.correctIndex >= texts.length) throw badRequest(`Question ${order + 1} has an invalid correct answer`);
    return { id: q.id, doc: { type: q.type, prompt: q.prompt, options: texts.map((text, i) => ({ id: letters[i], text })), correctOptionId: letters[q.correctIndex], points: q.points, order } };
  });

  const existing = await Question.find({ quizId: quiz._id }).select("_id").lean();
  const existingIds = new Set(existing.map((q) => String(q._id)));
  if (built.some((b) => b.id && !existingIds.has(b.id))) throw badRequest("Unknown question id");
  const keep = new Set(built.filter((b) => b.id).map((b) => b.id!));

  quiz.set(settings);
  await quiz.save();
  await Question.deleteMany({ quizId: quiz._id, _id: { $in: [...existingIds].filter((id) => !keep.has(id)) } });
  for (const b of built) {
    if (b.id) await Question.updateOne({ _id: b.id, quizId: quiz._id }, { $set: b.doc });
    else await Question.create({ ...b.doc, quizId: quiz._id });
  }
  res.json({ data: { id: quiz.id, title: quiz.title, questionCount: built.length }, message: "Quiz updated" });
});

quizzesRouter.get("/courses/:courseId/quizzes", async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertCanViewContent(course, req.user!);
  const quizzes = await Quiz.find({ courseId: course._id, status: "published" }).sort({ createdAt: 1 }).lean();
  const items = await Promise.all(
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
      if (req.user!.role !== "student") return base;
      const attempts = await QuizAttempt.find({ quizId: q._id, studentId: req.user!._id }).sort({ attemptNumber: 1 }).lean();
      const submitted = attempts.filter((a) => a.status === "submitted");
      return {
        ...base,
        attemptsUsed: attempts.length,
        passed: submitted.some((a) => a.passed),
        bestScore: submitted.length ? Math.max(...submitted.map((a) => Math.round((a.score / (a.maxScore || 1)) * 100))) : null,
        latestAttemptId: submitted.length ? String(submitted[submitted.length - 1]._id) : null,
      };
    }),
  );
  res.json({ data: items });
});

quizzesRouter.get("/quizzes/:quizId", async (req, res) => {
  const quiz = await Quiz.findById(oid(req.params.quizId));
  if (!quiz || quiz.status !== "published") throw notFound("Quiz not found");
  const course = await loadCourse(quiz.courseId);
  await assertCanViewContent(course, req.user!);
  const privileged = req.user!.role === "admin" || isOwner(course, req.user!);
  const questions = await Question.find({ quizId: quiz._id }).select(privileged ? "+correctOptionId" : "").sort({ order: 1 }).lean();
  res.json({
    data: {
      id: quiz.id,
      title: quiz.title,
      instructions: quiz.instructions,
      timeLimitSeconds: quiz.timeLimitSeconds,
      passMark: quiz.passMark,
      maxAttempts: quiz.maxAttempts,
      questions: questions.map((q) => ({ ...publicQuestion(q), ...(privileged ? { correctOptionId: (q as { correctOptionId?: string }).correctOptionId } : {}) })),
    },
  });
});

// ---------- Student: attempts ----------
async function gradeAndStore(attemptId: unknown, quizId: unknown, answers: { questionId: string; optionId: string }[]) {
  const questions = await Question.find({ quizId: quizId as never }).select("+correctOptionId").lean();
  const chosen = new Map(answers.map((a) => [a.questionId, a.optionId]));
  let score = 0;
  let maxScore = 0;
  const graded = questions.map((q) => {
    const optionId = chosen.get(String(q._id));
    const correct = optionId !== undefined && optionId === (q as { correctOptionId: string }).correctOptionId;
    maxScore += q.points;
    if (correct) score += q.points;
    return { questionId: q._id, optionId: optionId ?? "", correct, points: correct ? q.points : 0 };
  });
  return { graded, score, maxScore };
}

quizzesRouter.post("/quizzes/:quizId/attempts", requireRole("student"), async (req, res) => {
  const quiz = await Quiz.findById(oid(req.params.quizId));
  if (!quiz || quiz.status !== "published") throw notFound("Quiz not found");
  const course = await loadCourse(quiz.courseId);
  await assertEnrolledStudent(course, req.user!);
  const studentId = req.user!._id;
  const deadlineOf = (startedAt: Date) => new Date(startedAt.getTime() + quiz.timeLimitSeconds * 1000);

  const questions = await Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean();
  const respond = (attempt: { _id: unknown; attemptNumber: number; startedAt: Date }) =>
    res.status(201).json({
      data: {
        attemptId: String(attempt._id),
        attemptNumber: attempt.attemptNumber,
        startedAt: attempt.startedAt,
        deadline: deadlineOf(attempt.startedAt),
        timeLimitSeconds: quiz.timeLimitSeconds,
        questions: questions.map(publicQuestion),
      },
    });

  // Resume an attempt that is still within its time limit; close any that ran out of time.
  const open = await QuizAttempt.findOne({ quizId: quiz._id, studentId, status: "in_progress" });
  if (open) {
    if (Date.now() <= deadlineOf(open.startedAt).getTime() + GRACE_SECONDS * 1000) return respond(open);
    const { graded, score, maxScore } = await gradeAndStore(open._id, quiz._id, []);
    await QuizAttempt.updateOne({ _id: open._id, status: "in_progress" }, { status: "submitted", submittedAt: new Date(), answers: graded, score, maxScore, passed: false });
  }

  const used = await QuizAttempt.countDocuments({ quizId: quiz._id, studentId });
  if (used >= quiz.maxAttempts) throw forbidden("You have used all attempts for this quiz");
  try {
    const attempt = await QuizAttempt.create({ quizId: quiz._id, courseId: course._id, studentId, attemptNumber: used + 1 });
    return respond(attempt);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict("An attempt is already being created. Try again.");
    throw e;
  }
});

quizzesRouter.post("/quiz-attempts/:attemptId/submit", requireRole("student"), validateBody(submitBody), async (req, res) => {
  const attemptId = oid(req.params.attemptId);
  // Atomic claim: only one request can move an attempt out of "in_progress", so a double
  // submit (or a retry) can never be graded twice.
  const attempt = await QuizAttempt.findOneAndUpdate({ _id: attemptId, studentId: req.user!._id, status: "in_progress" }, { status: "submitted", submittedAt: new Date() }, { returnDocument: "after" });
  if (!attempt) {
    const exists = await QuizAttempt.exists({ _id: attemptId, studentId: req.user!._id });
    if (!exists) throw notFound("Attempt not found");
    throw conflict("This attempt was already submitted");
  }
  const quiz = await Quiz.findById(attempt.quizId);
  if (!quiz) throw notFound("Quiz not found");

  const late = attempt.submittedAt!.getTime() > attempt.startedAt.getTime() + (quiz.timeLimitSeconds + GRACE_SECONDS) * 1000;
  const answers = late ? [] : (req.body as z.infer<typeof submitBody>).answers;
  const { graded, score, maxScore } = await gradeAndStore(attempt._id, quiz._id, answers);
  const passed = !late && maxScore > 0 && (score / maxScore) * 100 >= quiz.passMark;
  await QuizAttempt.updateOne({ _id: attempt._id }, { answers: graded, score, maxScore, passed });
  if (passed) await evaluateCompletion(req.user!._id, attempt.courseId);

  if (late) throw new AppError(409, "TIME_EXPIRED", "The time limit was exceeded, so this attempt scored 0");
  res.json({ data: { attemptId, score, maxScore, percent: Math.round((score / (maxScore || 1)) * 100), passed } });
});

quizzesRouter.get("/quiz-attempts/:attemptId/result", async (req, res) => {
  const attempt = await QuizAttempt.findById(oid(req.params.attemptId));
  if (!attempt || attempt.status !== "submitted") throw notFound("Result not found");
  const quiz = await Quiz.findById(attempt.quizId);
  const course = await loadCourse(attempt.courseId);
  const isStudentOwner = attempt.studentId.equals(req.user!._id);
  if (!isStudentOwner && req.user!.role !== "admin" && !isOwner(course, req.user!)) throw forbidden();

  const questions = await Question.find({ quizId: attempt.quizId }).select("+correctOptionId").sort({ order: 1 }).lean();
  const byQuestion = new Map(attempt.answers.map((a) => [String(a.questionId), a]));
  res.json({
    data: {
      attemptId: attempt.id,
      quizTitle: quiz?.title,
      score: attempt.score,
      maxScore: attempt.maxScore,
      percent: Math.round((attempt.score / (attempt.maxScore || 1)) * 100),
      passMark: quiz?.passMark,
      passed: attempt.passed,
      submittedAt: attempt.submittedAt,
      questions: questions.map((q) => {
        const a = byQuestion.get(String(q._id));
        return { ...publicQuestion(q), chosenOptionId: a?.optionId || null, correctOptionId: (q as { correctOptionId: string }).correctOptionId, isCorrect: !!a?.correct };
      }),
    },
  });
});
