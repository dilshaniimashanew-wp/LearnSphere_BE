import { beforeAll, describe, expect, it } from "vitest";
import { Certificate, Notification } from "../src/modules/platform/platform.model.js";
import { Enrollment } from "../src/modules/enrollments/enrollment.model.js";
import { api, anonymous, createCategory, createCourse, createQuiz, resetDb, signedIn } from "./factory.js";

let instructor: Awaited<ReturnType<typeof signedIn>>;
let admin: Awaited<ReturnType<typeof signedIn>>;
let student: Awaited<ReturnType<typeof signedIn>>;
let categoryId: string;
let courseId: string;
let moduleId: string;
const lessonIds: string[] = [];

beforeAll(async () => {
  await resetDb();
  instructor = await signedIn("instructor");
  admin = await signedIn("admin");
  student = await signedIn("student");
  categoryId = String((await createCategory("Web")).id);
});

describe("course creation and validation", () => {
  const body = () => ({
    title: "Testing the workflow",
    summary: "A summary that is long enough.",
    description: "A description that is definitely longer than thirty characters.",
    categoryId,
    level: "beginner",
  });

  it("creates a draft owned by the instructor", async () => {
    const res = await instructor.agent.post(api("/courses")).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "draft", instructorId: instructor.user.id });
    courseId = res.body.data.id;
  });

  it("rejects short titles, unknown categories and unknown fields", async () => {
    expect((await instructor.agent.post(api("/courses")).send({ ...body(), title: "abc" })).status).toBe(400);
    expect((await instructor.agent.post(api("/courses")).send({ ...body(), categoryId: "6ad000000000000000000000" })).status).toBe(400);
    expect((await instructor.agent.post(api("/courses")).send({ ...body(), status: "published" })).status).toBe(400);
  });

  it("only allows https thumbnails", async () => {
    expect((await instructor.agent.patch(api(`/courses/${courseId}`)).send({ thumbnailUrl: "http://insecure.test/a.png" })).status).toBe(400);
    expect((await instructor.agent.patch(api(`/courses/${courseId}`)).send({ thumbnailUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await instructor.agent.patch(api(`/courses/${courseId}`)).send({ thumbnailUrl: "https://img.test/a.png" })).body.data.thumbnailUrl).toBe(
      "https://img.test/a.png",
    );
    expect((await instructor.agent.patch(api(`/courses/${courseId}`)).send({ thumbnailUrl: null })).body.data.thumbnailUrl).toBeNull();
  });

  it("will not submit an empty course for review", async () => {
    expect((await instructor.agent.post(api(`/courses/${courseId}/submit-review`))).status).toBe(400);
  });
});

describe("modules, lessons and moderation", () => {
  it("builds the curriculum", async () => {
    const mod = await instructor.agent.post(api(`/courses/${courseId}/modules`)).send({ title: "Module one" });
    expect(mod.status).toBe(201);
    moduleId = mod.body.data.id;
    for (const title of ["Lesson A", "Lesson B"]) {
      const l = await instructor.agent.post(api(`/modules/${moduleId}/lessons`)).send({ title, content: `Body of ${title}`, estimatedMinutes: 5 });
      expect(l.status).toBe(201);
      lessonIds.push(l.body.data.id);
    }
  });

  it("rejects script and data URLs in lesson video links", async () => {
    for (const videoUrl of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "ftp://files.test/x"]) {
      const res = await instructor.agent.post(api(`/modules/${moduleId}/lessons`)).send({ title: "Bad video", type: "video", videoUrl });
      expect(res.status, videoUrl).toBe(400);
    }
  });

  it("goes draft -> pending_review -> rejected (needs a note) -> resubmitted -> published", async () => {
    expect((await instructor.agent.post(api(`/courses/${courseId}/submit-review`))).body.data.status).toBe("pending_review");
    expect((await instructor.agent.post(api(`/courses/${courseId}/submit-review`))).status).toBe(400); // already pending
    expect((await admin.agent.get(api("/admin/courses/pending"))).body.data.some((c: { id: string }) => c.id === courseId)).toBe(true);

    expect((await admin.agent.patch(api(`/admin/courses/${courseId}/reject`)).send({ note: "" })).status).toBe(400);
    const rejected = await admin.agent.patch(api(`/admin/courses/${courseId}/reject`)).send({ note: "Add more detail." });
    expect(rejected.body.data).toMatchObject({ status: "rejected", moderationNote: "Add more detail." });
    expect((await Notification.findOne({ recipientId: instructor.user._id, type: "course_rejected" }))?.body).toContain("Add more detail.");

    expect((await instructor.agent.post(api(`/courses/${courseId}/submit-review`))).body.data.status).toBe("pending_review");
    const approved = await admin.agent.patch(api(`/admin/courses/${courseId}/approve`));
    expect(approved.body.data.status).toBe("published");
    expect(approved.body.data.moderationNote).toBeUndefined();
    expect((await admin.agent.patch(api(`/admin/courses/${courseId}/approve`))).status).toBe(409);
  });

  it("makes the published course public, but keeps lesson bodies private", async () => {
    const res = await anonymous().get(api("/courses?pageSize=50"));
    expect(res.body.data.items.map((c: { id: string }) => c.id)).toContain(courseId);
    const detail = await anonymous().get(api(`/courses/${courseId}`));
    expect(detail.body.data.modules[0].lessons).toHaveLength(2);
    expect(JSON.stringify(detail.body)).not.toContain("Body of Lesson A");
  });

  it("filters and searches the catalog without leaking drafts", async () => {
    await createCourse(instructor.user._id, { status: "draft", title: "Secret draft course" });
    expect((await anonymous().get(api("/courses?q=Secret"))).body.data.total).toBe(0);
    expect((await anonymous().get(api("/courses?q=Testing"))).body.data.total).toBe(1);
    expect((await anonymous().get(api("/courses?q=%5B"))).status).toBe(200); // regex metacharacters are escaped
    expect((await anonymous().get(api(`/courses?category=${categoryId}`))).body.data.total).toBe(1);
  });
});

describe("enrollment, progress and completion", () => {
  it("enrolls once; a second attempt conflicts, instructors cannot enroll", async () => {
    expect((await student.agent.post(api(`/courses/${courseId}/enroll`))).status).toBe(201);
    expect((await student.agent.post(api(`/courses/${courseId}/enroll`))).status).toBe(409);
    expect((await instructor.agent.post(api(`/courses/${courseId}/enroll`))).status).toBe(403);
    expect(await Enrollment.countDocuments({ studentId: student.user._id, courseId })).toBe(1);
  });

  it("survives a burst of simultaneous enrollments without duplicates", async () => {
    const racer = await signedIn("student");
    const results = await Promise.all(Array.from({ length: 8 }, () => racer.agent.post(api(`/courses/${courseId}/enroll`))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Enrollment.countDocuments({ studentId: racer.user._id, courseId })).toBe(1);
  });

  it("lets the enrolled student read lesson content", async () => {
    const res = await student.agent.get(api(`/courses/${courseId}/lessons`));
    expect(res.status).toBe(200);
    expect(res.body.data.modules[0].lessons[0].content).toBe("Body of Lesson A");
  });

  it("tracks progress idempotently", async () => {
    const first = await student.agent.post(api(`/lessons/${lessonIds[0]}/progress`)).send({ completed: true });
    expect(first.body.data.percent).toBe(50);
    const again = await student.agent.post(api(`/lessons/${lessonIds[0]}/progress`)).send({ completed: true });
    expect(again.body.data.percent).toBe(50);
    const undo = await student.agent.post(api(`/lessons/${lessonIds[0]}/progress`)).send({ completed: false });
    expect(undo.body.data.percent).toBe(0);
    await student.agent.post(api(`/lessons/${lessonIds[0]}/progress`)).send({ completed: true });
  });

  it("does not complete the course while a published quiz is unpassed, then issues exactly one certificate", async () => {
    const { quiz, q1, q2 } = await createQuiz(courseId as never, { passMark: 50 });
    const done = await student.agent.post(api(`/lessons/${lessonIds[1]}/progress`)).send({ completed: true });
    expect(done.body.data).toMatchObject({ percent: 100, complete: false });
    expect(await Certificate.countDocuments({ studentId: student.user._id })).toBe(0);

    const start = await student.agent.post(api(`/quizzes/${quiz.id}/attempts`));
    const submit = await student.agent.post(api(`/quiz-attempts/${start.body.data.attemptId}/submit`)).send({
      answers: [
        { questionId: q1.id, optionId: "a" },
        { questionId: q2.id, optionId: "b" },
      ],
    });
    expect(submit.body.data).toMatchObject({ score: 3, maxScore: 3, passed: true });

    const certs = await student.agent.get(api("/certificates/me"));
    expect(certs.body.data).toHaveLength(1);
    expect(certs.body.data[0].code).toMatch(/^LS-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect((await student.agent.get(api("/enrollments/me"))).body.data[0].status).toBe("completed");

    await student.agent.post(api(`/lessons/${lessonIds[1]}/progress`)).send({ completed: true });
    expect(await Certificate.countDocuments({ studentId: student.user._id })).toBe(1);
    expect(await Notification.countDocuments({ recipientId: student.user._id, type: "course_completed" })).toBe(1);
  });

  it("verifies a certificate publicly with minimal data, and 404s unknown codes", async () => {
    const code = (await student.agent.get(api("/certificates/me"))).body.data[0].code;
    const res = await anonymous().get(api(`/certificates/verify/${code.toLowerCase()}`));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(["courseTitle", "issuedAt", "studentName"]);
    expect((await anonymous().get(api("/certificates/verify/LS-0000-0000"))).status).toBe(404);
  });

  it("lists enrolled students for the owner only", async () => {
    expect((await instructor.agent.get(api(`/courses/${courseId}/students`))).body.data.length).toBeGreaterThanOrEqual(2);
  });
});
