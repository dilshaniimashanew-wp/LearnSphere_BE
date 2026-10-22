import { beforeAll, describe, expect, it } from "vitest";
import { api, anonymous, createAssignment, createCourse, createQuiz, resetDb, signedIn } from "./factory.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

async function setup() {
  await resetDb();
  const owner = await signedIn("instructor");
  const other = await signedIn("instructor");
  const student = await signedIn("student");
  const admin = await signedIn("admin");
  const { course, module: mod, lessons } = await createCourse(owner.user._id, { status: "published" });
  const draft = await createCourse(owner.user._id, { status: "draft" });
  const { quiz } = await createQuiz(course._id);
  const assignment = await createAssignment(course._id);
  return { owner, other, student, admin, course, mod, lesson: lessons[0], draft: draft.course, quiz, assignment };
}

beforeAll(async () => {
  ctx = await setup();
});

describe("anonymous users", () => {
  it.each([
    ["GET", "/auth/me"],
    ["GET", "/users/me"],
    ["GET", "/enrollments/me"],
    ["GET", "/notifications"],
    ["GET", "/admin/users"],
    ["GET", "/admin/analytics"],
    ["GET", "/instructor/analytics"],
    ["GET", "/courses/mine"],
  ])("%s %s requires a session (401)", async (method, path) => {
    const res = await anonymous()[method.toLowerCase() as "get"](api(path));
    expect(res.status).toBe(401);
  });

  it("can browse published courses and the catalog but not drafts", async () => {
    expect((await anonymous().get(api("/courses"))).status).toBe(200);
    expect((await anonymous().get(api(`/courses/${ctx.course.id}`))).status).toBe(200);
    expect((await anonymous().get(api(`/courses/${ctx.draft.id}`))).status).toBe(404);
  });

  it("never sees lesson bodies of a published course", async () => {
    const res = await anonymous().get(api(`/courses/${ctx.course.id}`));
    expect(JSON.stringify(res.body)).not.toContain("Body 1");
  });

  it("gets a 404, not a 500, for malformed ids", async () => {
    expect((await anonymous().get(api("/courses/not-an-id"))).status).toBe(404);
  });
});

describe("students", () => {
  it.each([
    ["GET", "/admin/users"],
    ["GET", "/admin/analytics"],
    ["GET", "/admin/audit-logs"],
    ["GET", "/instructor/analytics"],
    ["GET", "/instructor/submissions"],
    ["GET", "/courses/mine"],
  ])("cannot call %s %s (403)", async (method, path) => {
    const res = await ctx.student.agent[method.toLowerCase() as "get"](api(path));
    expect(res.status).toBe(403);
  });

  it("cannot create, edit or approve courses", async () => {
    expect((await ctx.student.agent.post(api("/courses")).send({})).status).toBe(403);
    expect((await ctx.student.agent.patch(api(`/courses/${ctx.course.id}`)).send({ title: "Hacked title" })).status).toBe(403);
    expect((await ctx.student.agent.patch(api(`/admin/courses/${ctx.draft.id}/approve`))).status).toBe(403);
  });

  it("cannot read lessons, quizzes, assignments or announcements without enrolling", async () => {
    for (const path of [`/courses/${ctx.course.id}/lessons`, `/courses/${ctx.course.id}/quizzes`, `/quizzes/${ctx.quiz.id}`, `/courses/${ctx.course.id}/assignments`, `/assignments/${ctx.assignment.id}`, `/courses/${ctx.course.id}/announcements`]) {
      expect((await ctx.student.agent.get(api(path))).status, path).toBe(403);
    }
  });

  it("cannot manage content, grade, or list students", async () => {
    expect((await ctx.student.agent.post(api(`/courses/${ctx.course.id}/modules`)).send({ title: "Evil" })).status).toBe(403);
    expect((await ctx.student.agent.get(api(`/courses/${ctx.course.id}/students`))).status).toBe(403);
    expect((await ctx.student.agent.patch(api(`/submissions/${ctx.course.id}/grade`)).send({ pointsAwarded: 1 })).status).toBe(403);
  });

  it("cannot enroll in an unpublished course", async () => {
    expect((await ctx.student.agent.post(api(`/courses/${ctx.draft.id}/enroll`))).status).toBe(403);
  });
});

describe("another instructor", () => {
  it("cannot edit, extend, archive or list students of a course they do not own", async () => {
    const a = ctx.other.agent;
    expect((await a.patch(api(`/courses/${ctx.course.id}`)).send({ title: "Hijacked title" })).status).toBe(403);
    expect((await a.post(api(`/courses/${ctx.course.id}/modules`)).send({ title: "Evil" })).status).toBe(403);
    expect((await a.post(api(`/modules/${ctx.mod.id}/lessons`)).send({ title: "Evil lesson" })).status).toBe(403);
    expect((await a.patch(api(`/lessons/${ctx.lesson.id}`)).send({ title: "Renamed" })).status).toBe(403);
    expect((await a.delete(api(`/lessons/${ctx.lesson.id}`))).status).toBe(403);
    expect((await a.post(api(`/courses/${ctx.course.id}/archive`))).status).toBe(403);
    expect((await a.get(api(`/courses/${ctx.course.id}/students`))).status).toBe(403);
    expect((await a.post(api(`/courses/${ctx.course.id}/quizzes`)).send({ title: "Quiz", questions: [{ type: "true_false", prompt: "Is it?", correctIndex: 0 }] })).status).toBe(403);
    expect((await a.post(api(`/courses/${ctx.course.id}/assignments`)).send({ title: "Task", instructions: "Do it", dueAt: new Date().toISOString() })).status).toBe(403);
    expect((await a.post(api(`/courses/${ctx.course.id}/announcements`)).send({ title: "Hello", body: "Valid message" })).status).toBe(403);
  });

  it("cannot see another instructor's draft", async () => {
    expect((await ctx.other.agent.get(api(`/courses/${ctx.draft.id}`))).status).toBe(404);
  });

  it("cannot call admin endpoints", async () => {
    expect((await ctx.other.agent.get(api("/admin/users"))).status).toBe(403);
    expect((await ctx.other.agent.patch(api(`/admin/courses/${ctx.draft.id}/approve`))).status).toBe(403);
  });
});

describe("the owning instructor and admins", () => {
  it("owner can read an unpublished course; admin can too", async () => {
    expect((await ctx.owner.agent.get(api(`/courses/${ctx.draft.id}`))).status).toBe(200);
    expect((await ctx.admin.agent.get(api(`/courses/${ctx.draft.id}`))).status).toBe(200);
  });

  it("instructors cannot call admin-only endpoints even for their own course", async () => {
    expect((await ctx.owner.agent.patch(api(`/admin/courses/${ctx.draft.id}/approve`))).status).toBe(403);
  });
});
