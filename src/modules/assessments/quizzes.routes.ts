import { Router } from "express";
import { protect } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { notFound } from "../../shared/errors.js";
import { assertCanViewContent, assertOwner, loadCourse, oid } from "../../shared/helpers.js";
import { Quiz } from "./assessment.model.js";
import { createQuizBody, submitAttemptBody, updateQuizBody } from "./quiz.schemas.js";
import * as quizzes from "./quiz.service.js";

export const quizzesRouter = Router();

// ---------- Instructor ----------
quizzesRouter.post("/courses/:courseId/quizzes", ...protect("instructor"), validateBody(createQuizBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const { questions, ...settings } = req.body;
  const { quiz, questionCount } = await quizzes.createQuiz(course, settings, questions);
  res.status(201).json({ data: { id: quiz.id, title: quiz.title, questionCount }, message: "Quiz created" });
});

quizzesRouter.put("/quizzes/:quizId", ...protect("instructor"), validateBody(updateQuizBody), async (req, res) => {
  const quiz = await Quiz.findById(oid(req.params.quizId));
  if (!quiz) throw notFound("Quiz not found");
  assertOwner(await loadCourse(quiz.courseId), req.user!);
  const { questions, ...settings } = req.body;
  const result = await quizzes.updateQuiz(quiz.id, settings, questions);
  res.json({ data: { id: result.quiz.id, title: result.quiz.title, questionCount: result.questionCount }, message: "Quiz updated" });
});

// ---------- Reading ----------
quizzesRouter.get("/courses/:courseId/quizzes", ...protect(), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertCanViewContent(course, req.user!);
  res.json({ data: await quizzes.listQuizzes(course, req.user!) });
});

quizzesRouter.get("/quizzes/:quizId", ...protect(), async (req, res) => {
  const { quiz, questions } = await quizzes.getQuizDetail(oid(req.params.quizId), req.user!);
  res.json({
    data: { id: quiz.id, title: quiz.title, instructions: quiz.instructions, timeLimitSeconds: quiz.timeLimitSeconds, passMark: quiz.passMark, maxAttempts: quiz.maxAttempts, questions },
  });
});

// ---------- Student attempts ----------
quizzesRouter.post("/quizzes/:quizId/attempts", ...protect("student"), async (req, res) => {
  res.status(201).json({ data: await quizzes.startAttempt(oid(req.params.quizId), req.user!) });
});

quizzesRouter.post("/quiz-attempts/:attemptId/submit", ...protect("student"), validateBody(submitAttemptBody), async (req, res) => {
  res.json({ data: await quizzes.submitAttempt(oid(req.params.attemptId), req.user!, req.body.answers) });
});

quizzesRouter.get("/quiz-attempts/:attemptId/result", ...protect(), async (req, res) => {
  res.json({ data: await quizzes.getAttemptResult(oid(req.params.attemptId), req.user!) });
});
