import mongoose from "mongoose";
import request from "supertest";
import { app } from "../src/app.js";
import { connectDb } from "../src/config/db.js";
import { Assignment, Question, Quiz } from "../src/modules/assessments/assessment.model.js";
import { hashPassword } from "../src/modules/auth/auth.service.js";
import { Category, Course, CourseModule, Lesson } from "../src/modules/courses/course.model.js";
import { User, type Role } from "../src/modules/users/user.model.js";
import { uniqueSlug } from "../src/shared/helpers.js";

export const PASSWORD = "Passw0rd!";
export const api = (path: string) => `/api/v1${path}`;

let counter = 0;

/** Connects once and empties every collection so each test file starts from nothing. */
export async function resetDb() {
  if (mongoose.connection.readyState !== 1) await connectDb();
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function createUser(role: Role = "student", overrides: Partial<{ name: string; email: string; status: "active" | "suspended" }> = {}) {
  counter += 1;
  const email = overrides.email ?? `${role}${counter}@test.local`;
  const user = await User.create({
    name: overrides.name ?? `${role[0].toUpperCase()}${role.slice(1)} ${counter}`,
    email,
    role,
    status: overrides.status ?? "active",
    passwordHash: await hashPassword(PASSWORD),
  });
  return { user, email, password: PASSWORD };
}

/** A supertest agent that keeps the session cookie, already signed in. */
export async function loginAs(email: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post(api("/auth/login")).send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function signedIn(role: Role = "student") {
  const { user, email } = await createUser(role);
  return { user, email, agent: await loginAs(email) };
}

export const anonymous = () => request(app);

export async function createCategory(name = `Category ${++counter}`) {
  return Category.create({ name, slug: uniqueSlug(name) });
}

/** Builds a course straight in the database (fast), with one module and the given lessons. */
export async function createCourse(
  instructorId: mongoose.Types.ObjectId,
  opts: { status?: "draft" | "pending_review" | "published" | "rejected" | "archived"; lessons?: number; title?: string } = {},
) {
  const category = await createCategory();
  const title = opts.title ?? `Test course ${++counter}`;
  const course = await Course.create({
    instructorId,
    categoryId: category._id,
    title,
    slug: uniqueSlug(title),
    summary: "A short summary for the test course.",
    description: "A description that is comfortably longer than thirty characters.",
    level: "beginner",
    status: opts.status ?? "published",
    publishedAt: opts.status === "published" || opts.status === undefined ? new Date() : undefined,
  });
  const mod = await CourseModule.create({ courseId: course._id, title: "Module 1", order: 0 });
  const lessons = [];
  for (let i = 0; i < (opts.lessons ?? 2); i++) {
    lessons.push(await Lesson.create({ courseId: course._id, moduleId: mod._id, title: `Lesson ${i + 1}`, content: `Body ${i + 1}`, order: i }));
  }
  return { course, category, module: mod, lessons };
}

/** A quiz whose correct option is always "a" for the first question and "b" for the second. */
export async function createQuiz(courseId: mongoose.Types.ObjectId, opts: { passMark?: number; maxAttempts?: number; timeLimitSeconds?: number } = {}) {
  const quiz = await Quiz.create({
    courseId,
    title: "Test quiz",
    passMark: opts.passMark ?? 50,
    maxAttempts: opts.maxAttempts ?? 3,
    timeLimitSeconds: opts.timeLimitSeconds ?? 600,
  });
  const [q1, q2] = await Question.insertMany([
    {
      quizId: quiz._id,
      type: "multiple_choice",
      prompt: "2 + 2 = ?",
      options: [
        { id: "a", text: "4" },
        { id: "b", text: "5" },
      ],
      correctOptionId: "a",
      points: 2,
      order: 0,
    },
    {
      quizId: quiz._id,
      type: "true_false",
      prompt: "The sky is green.",
      options: [
        { id: "a", text: "True" },
        { id: "b", text: "False" },
      ],
      correctOptionId: "b",
      points: 1,
      order: 1,
    },
  ]);
  return { quiz, q1, q2 };
}

export async function createAssignment(courseId: mongoose.Types.ObjectId, opts: { dueInMs?: number; maxPoints?: number; allowResubmission?: boolean } = {}) {
  return Assignment.create({
    courseId,
    title: "Test assignment",
    instructions: "Do the thing.",
    dueAt: new Date(Date.now() + (opts.dueInMs ?? 86_400_000)),
    maxPoints: opts.maxPoints ?? 20,
    allowResubmission: opts.allowResubmission ?? false,
  });
}
