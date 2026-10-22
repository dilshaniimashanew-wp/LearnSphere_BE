import { beforeAll, describe, expect, it } from "vitest";
import { Notification } from "../src/modules/platform/platform.model.js";
import { Enrollment } from "../src/modules/enrollments/enrollment.model.js";
import { api, createAssignment, createCourse, resetDb, signedIn } from "./factory.js";

let owner: Awaited<ReturnType<typeof signedIn>>;
let other: Awaited<ReturnType<typeof signedIn>>;
let student: Awaited<ReturnType<typeof signedIn>>;
let stranger: Awaited<ReturnType<typeof signedIn>>;
let courseId: string;
let assignmentId: string;
let submissionId: string;

beforeAll(async () => {
  await resetDb();
  owner = await signedIn("instructor");
  other = await signedIn("instructor");
  student = await signedIn("student");
  stranger = await signedIn("student");
  const { course } = await createCourse(owner.user._id, { status: "published" });
  courseId = course.id;
  assignmentId = (await createAssignment(course._id, { maxPoints: 20 })).id;
  await Enrollment.create({ studentId: student.user._id, courseId: course._id });
});

describe("creating assignments", () => {
  it("notifies every enrolled student", async () => {
    const res = await owner.agent
      .post(api(`/courses/${courseId}/assignments`))
      .send({ title: "Essay", instructions: "Write an essay.", dueAt: new Date(Date.now() + 86_400_000).toISOString(), maxPoints: 50 });
    expect(res.status).toBe(201);
    expect(await Notification.countDocuments({ recipientId: student.user._id, type: "new_assignment" })).toBe(1);
  });

  it("validates input", async () => {
    expect((await owner.agent.post(api(`/courses/${courseId}/assignments`)).send({ title: "x", instructions: "y", dueAt: "not-a-date" })).status).toBe(400);
  });
});

describe("submitting", () => {
  it("requires content and enrollment", async () => {
    expect((await student.agent.post(api(`/assignments/${assignmentId}/submissions`)).send({})).status).toBe(400);
    expect((await student.agent.post(api(`/assignments/${assignmentId}/submissions`)).send({ fileUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await stranger.agent.post(api(`/assignments/${assignmentId}/submissions`)).send({ textResponse: "hi" })).status).toBe(403);
    expect((await owner.agent.post(api(`/assignments/${assignmentId}/submissions`)).send({ textResponse: "hi" })).status).toBe(403);
  });

  it("accepts an on-time submission and notifies the instructor", async () => {
    const res = await student.agent.post(api(`/assignments/${assignmentId}/submissions`)).send({ textResponse: "My work" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ isLate: false, status: "submitted", version: 1 });
    submissionId = res.body.data.id;
    expect(await Notification.countDocuments({ recipientId: owner.user._id, type: "new_submission" })).toBe(1);
  });

  it("refuses a resubmission when the policy forbids it", async () => {
    expect((await student.agent.post(api(`/assignments/${assignmentId}/submissions`)).send({ textResponse: "Again" })).status).toBe(409);
  });

  it("marks late work and allows resubmission only when permitted", async () => {
    const { course } = await createCourse(owner.user._id, { status: "published" });
    await Enrollment.create({ studentId: student.user._id, courseId: course._id });
    const late = await createAssignment(course._id, { dueInMs: -60_000, allowResubmission: true });
    const first = await student.agent.post(api(`/assignments/${late.id}/submissions`)).send({ textResponse: "Late work" });
    expect(first.body.data.isLate).toBe(true);
    const second = await student.agent.post(api(`/assignments/${late.id}/submissions`)).send({ textResponse: "Better" });
    expect(second.status).toBe(201);
    expect(second.body.data.version).toBe(2);
  });
});

describe("grading", () => {
  it("only the owning instructor (or an admin) can grade", async () => {
    expect((await other.agent.patch(api(`/submissions/${submissionId}/grade`)).send({ pointsAwarded: 5, feedback: "x" })).status).toBe(403);
    expect((await student.agent.patch(api(`/submissions/${submissionId}/grade`)).send({ pointsAwarded: 20 })).status).toBe(403);
  });

  it("validates points against the assignment maximum", async () => {
    expect((await owner.agent.patch(api(`/submissions/${submissionId}/grade`)).send({ pointsAwarded: 21 })).status).toBe(400);
    expect((await owner.agent.patch(api(`/submissions/${submissionId}/grade`)).send({ pointsAwarded: -1 })).status).toBe(400);
  });

  it("saves the grade, notifies the student and exposes it in their grades", async () => {
    const res = await owner.agent.patch(api(`/submissions/${submissionId}/grade`)).send({ pointsAwarded: 18, feedback: "Nice work." });
    expect(res.body.data).toMatchObject({ status: "graded", grade: { pointsAwarded: 18, feedback: "Nice work." } });
    expect(await Notification.countDocuments({ recipientId: student.user._id, type: "assignment_graded" })).toBe(1);
    const grades = await student.agent.get(api("/grades/me"));
    expect(grades.body.data.some((g: { kind: string; score: string }) => g.kind === "assignment" && g.score === "18 / 20")).toBe(true);
  });

  it("limits the instructor submission list to their own courses", async () => {
    const mine = await owner.agent.get(api("/instructor/submissions"));
    expect(mine.body.data.items.some((s: { id: string }) => s.id === submissionId)).toBe(true);
    const theirs = await other.agent.get(api("/instructor/submissions"));
    expect(theirs.body.data.items).toHaveLength(0);
    expect((await other.agent.get(api(`/assignments/${assignmentId}/submissions`))).status).toBe(403);
  });

  it("hides grade details from the student until graded", async () => {
    const { course } = await createCourse(owner.user._id, { status: "published" });
    await Enrollment.create({ studentId: stranger.user._id, courseId: course._id });
    const a = await createAssignment(course._id);
    const sub = await stranger.agent.post(api(`/assignments/${a.id}/submissions`)).send({ textResponse: "Pending" });
    expect(sub.body.data.grade).toBeNull();
  });
});
