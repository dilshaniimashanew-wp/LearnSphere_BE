import { beforeAll, describe, expect, it } from "vitest";
import { QuizAttempt } from "../src/modules/assessments/assessment.model.js";
import { Enrollment } from "../src/modules/enrollments/enrollment.model.js";
import { api, createCourse, createQuiz, resetDb, signedIn } from "./factory.js";

let owner: Awaited<ReturnType<typeof signedIn>>;
let other: Awaited<ReturnType<typeof signedIn>>;
let student: Awaited<ReturnType<typeof signedIn>>;
let stranger: Awaited<ReturnType<typeof signedIn>>;
let courseId: string;
let quizId: string;
let q1: string;
let q2: string;

const correct = () => [
  { questionId: q1, optionId: "a" },
  { questionId: q2, optionId: "b" },
];

beforeAll(async () => {
  await resetDb();
  owner = await signedIn("instructor");
  other = await signedIn("instructor");
  student = await signedIn("student");
  stranger = await signedIn("student");
  const { course } = await createCourse(owner.user._id, { status: "published" });
  courseId = course.id;
  const q = await createQuiz(course._id, { passMark: 60, maxAttempts: 2, timeLimitSeconds: 300 });
  quizId = q.quiz.id;
  q1 = q.q1.id;
  q2 = q.q2.id;
  await Enrollment.create({ studentId: student.user._id, courseId: course._id });
});

describe("answers are protected", () => {
  it("never sends correct answers to a student before submission", async () => {
    const view = await student.agent.get(api(`/quizzes/${quizId}`));
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain("correctOptionId");
    const start = await student.agent.post(api(`/quizzes/${quizId}/attempts`));
    expect(JSON.stringify(start.body)).not.toContain("correctOptionId");
    await QuizAttempt.deleteMany({});
  });

  it("shows answers to the owner (needed for editing) but not to another instructor", async () => {
    expect((await owner.agent.get(api(`/quizzes/${quizId}`))).body.data.questions.every((q: { correctOptionId?: string }) => q.correctOptionId)).toBe(true);
    expect((await other.agent.get(api(`/quizzes/${quizId}`))).status).toBe(403);
  });

  it("blocks students who are not enrolled", async () => {
    expect((await stranger.agent.get(api(`/quizzes/${quizId}`))).status).toBe(403);
    expect((await stranger.agent.post(api(`/quizzes/${quizId}/attempts`))).status).toBe(403);
  });
});

describe("attempts and grading", () => {
  let attemptId: string;

  it("resumes the open attempt instead of creating another", async () => {
    const a = await student.agent.post(api(`/quizzes/${quizId}/attempts`));
    const b = await student.agent.post(api(`/quizzes/${quizId}/attempts`));
    expect(a.status).toBe(201);
    expect(b.body.data.attemptId).toBe(a.body.data.attemptId);
    expect(a.body.data.questions).toHaveLength(2);
    attemptId = a.body.data.attemptId;
  });

  it("will not let another user submit or read someone else's attempt", async () => {
    // Another student cannot even learn that the attempt exists (404); instructors are refused by role (403).
    expect((await stranger.agent.post(api(`/quiz-attempts/${attemptId}/submit`)).send({ answers: [] })).status).toBe(404);
    expect((await other.agent.post(api(`/quiz-attempts/${attemptId}/submit`)).send({ answers: [] })).status).toBe(403);
  });

  it("validates the submitted payload", async () => {
    expect((await student.agent.post(api(`/quiz-attempts/${attemptId}/submit`)).send({ answers: "nope" })).status).toBe(400);
    expect((await student.agent.post(api(`/quiz-attempts/${attemptId}/submit`)).send({ answers: [], extra: 1 })).status).toBe(400);
  });

  it("grades on the server: partial credit does not pass a 60% mark", async () => {
    const res = await student.agent.post(api(`/quiz-attempts/${attemptId}/submit`)).send({
      answers: [
        { questionId: q1, optionId: "b" },
        { questionId: q2, optionId: "b" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ score: 1, maxScore: 3, passed: false });
  });

  it("rejects a second submit of the same attempt", async () => {
    expect((await student.agent.post(api(`/quiz-attempts/${attemptId}/submit`)).send({ answers: correct() })).status).toBe(409);
  });

  it("handles simultaneous double-submits so only one is graded", async () => {
    const start = await student.agent.post(api(`/quizzes/${quizId}/attempts`));
    const id = start.body.data.attemptId;
    const results = await Promise.all([1, 2, 3].map(() => student.agent.post(api(`/quiz-attempts/${id}/submit`)).send({ answers: correct() })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    attemptId = id;
  });

  it("enforces the maximum number of attempts", async () => {
    expect((await student.agent.post(api(`/quizzes/${quizId}/attempts`))).status).toBe(403);
  });

  it("exposes a detailed result to the student and the course owner only", async () => {
    const mine = await student.agent.get(api(`/quiz-attempts/${attemptId}/result`));
    expect(mine.body.data).toMatchObject({ score: 3, passed: true });
    expect(mine.body.data.questions.every((q: { isCorrect: boolean }) => q.isCorrect)).toBe(true);
    expect((await owner.agent.get(api(`/quiz-attempts/${attemptId}/result`))).status).toBe(200);
    expect((await other.agent.get(api(`/quiz-attempts/${attemptId}/result`))).status).toBe(403);
    expect((await stranger.agent.get(api(`/quiz-attempts/${attemptId}/result`))).status).toBe(403);
  });
});

describe("time limit", () => {
  it("scores 0 and conflicts when submitted after the deadline", async () => {
    const lateStudent = await signedIn("student");
    const { course } = await createCourse(owner.user._id, { status: "published" });
    const q = await createQuiz(course._id, { timeLimitSeconds: 60 });
    await Enrollment.create({ studentId: lateStudent.user._id, courseId: course._id });

    const start = await lateStudent.agent.post(api(`/quizzes/${q.quiz.id}/attempts`));
    await QuizAttempt.updateOne({ _id: start.body.data.attemptId }, { startedAt: new Date(Date.now() - 10 * 60_000) });
    const res = await lateStudent.agent.post(api(`/quiz-attempts/${start.body.data.attemptId}/submit`)).send({
      answers: [
        { questionId: q.q1.id, optionId: "a" },
        { questionId: q.q2.id, optionId: "b" },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TIME_EXPIRED");
    const stored = await QuizAttempt.findById(start.body.data.attemptId);
    expect(stored).toMatchObject({ status: "submitted", score: 0, passed: false });
  });
});

describe("creating and editing quizzes", () => {
  const question = (extra = {}) => ({ type: "multiple_choice", prompt: "Pick the right one", options: ["x", "y", "z"], correctIndex: 1, ...extra });

  it("creates a quiz and rejects invalid questions", async () => {
    const ok = await owner.agent
      .post(api(`/courses/${courseId}/quizzes`))
      .send({ title: "Created quiz", questions: [question(), { type: "true_false", prompt: "True or false?", correctIndex: 0 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.questionCount).toBe(2);
    expect((await owner.agent.post(api(`/courses/${courseId}/quizzes`)).send({ title: "Bad", questions: [question({ options: ["only one"] })] })).status).toBe(
      400,
    );
    expect((await owner.agent.post(api(`/courses/${courseId}/quizzes`)).send({ title: "Bad", questions: [question({ correctIndex: 9 })] })).status).toBe(400);
    expect((await owner.agent.post(api(`/courses/${courseId}/quizzes`)).send({ title: "Bad", questions: [] })).status).toBe(400);
  });

  it("edits in place: keeps ids, updates, adds and removes questions", async () => {
    const before = (await owner.agent.get(api(`/quizzes/${quizId}`))).body.data.questions;
    const toBody = (q: { id: string; type: string; prompt: string; options: { text: string }[]; correctOptionId: string }) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: q.type === "true_false" ? [] : q.options.map((o) => o.text),
      correctIndex: q.correctOptionId === "a" ? 0 : 1,
    });
    const edited = [{ ...toBody(before[0]), prompt: "Edited prompt?" }, question()];
    const res = await owner.agent
      .put(api(`/quizzes/${quizId}`))
      .send({ title: "Quiz v2", passMark: 80, maxAttempts: 5, timeLimitSeconds: 120, questions: edited });
    expect(res.status).toBe(200);

    const after = (await owner.agent.get(api(`/quizzes/${quizId}`))).body.data;
    expect(after).toMatchObject({ title: "Quiz v2", passMark: 80, maxAttempts: 5 });
    expect(after.questions).toHaveLength(2);
    expect(after.questions[0]).toMatchObject({ id: before[0].id, prompt: "Edited prompt?" });
    expect(after.questions.some((q: { id: string }) => q.id === before[1].id)).toBe(false);
  });

  it("refuses edits from non-owners and unknown question ids", async () => {
    const body = { title: "x quiz", passMark: 50, maxAttempts: 1, timeLimitSeconds: 60, questions: [question()] };
    expect((await other.agent.put(api(`/quizzes/${quizId}`)).send(body)).status).toBe(403);
    expect((await student.agent.put(api(`/quizzes/${quizId}`)).send(body)).status).toBe(403);
    expect((await owner.agent.put(api(`/quizzes/${quizId}`)).send({ ...body, questions: [question({ id: "6ad000000000000000000000" })] })).status).toBe(400);
  });
});
