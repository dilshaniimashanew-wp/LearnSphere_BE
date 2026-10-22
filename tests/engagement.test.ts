import { beforeAll, describe, expect, it } from "vitest";
import { Notification } from "../src/modules/platform/platform.model.js";
import { Enrollment } from "../src/modules/enrollments/enrollment.model.js";
import { api, anonymous, createCourse, resetDb, signedIn } from "./factory.js";

let owner: Awaited<ReturnType<typeof signedIn>>;
let other: Awaited<ReturnType<typeof signedIn>>;
let student: Awaited<ReturnType<typeof signedIn>>;
let student2: Awaited<ReturnType<typeof signedIn>>;
let stranger: Awaited<ReturnType<typeof signedIn>>;
let courseId: string;
let moduleIds: string[];
let lessonIds: string[];

beforeAll(async () => {
  await resetDb();
  owner = await signedIn("instructor");
  other = await signedIn("instructor");
  student = await signedIn("student");
  student2 = await signedIn("student");
  stranger = await signedIn("student");
  const { course, module: m1, lessons } = await createCourse(owner.user._id, { status: "published", lessons: 3 });
  courseId = course.id;
  const m2 = await owner.agent.post(api(`/courses/${course.id}/modules`)).send({ title: "Module 2" });
  moduleIds = [m1.id, m2.body.data.id];
  lessonIds = lessons.map((l) => l.id);
  await Enrollment.create([
    { studentId: student.user._id, courseId: course._id },
    { studentId: student2.user._id, courseId: course._id },
  ]);
});

describe("announcements", () => {
  it("only the owner can post, and enrolled students are notified", async () => {
    expect((await other.agent.post(api(`/courses/${courseId}/announcements`)).send({ title: "Hello", body: "Hijack" })).status).toBe(403);
    expect((await student.agent.post(api(`/courses/${courseId}/announcements`)).send({ title: "Hello", body: "Nope" })).status).toBe(403);
    expect((await owner.agent.post(api(`/courses/${courseId}/announcements`)).send({ title: "", body: "x" })).status).toBe(400);
    const res = await owner.agent.post(api(`/courses/${courseId}/announcements`)).send({ title: "Quiz tomorrow", body: "Revise lessons 1 to 3." });
    expect(res.status).toBe(201);
    expect(await Notification.countDocuments({ type: "announcement", recipientId: student.user._id })).toBe(1);
    expect(await Notification.countDocuments({ type: "announcement", recipientId: stranger.user._id })).toBe(0);
  });

  it("is readable by enrolled students but not by strangers", async () => {
    expect((await student.agent.get(api(`/courses/${courseId}/announcements`))).body.data).toHaveLength(1);
    expect((await stranger.agent.get(api(`/courses/${courseId}/announcements`))).status).toBe(403);
  });

  it("only the owner can delete", async () => {
    const id = (await student.agent.get(api(`/courses/${courseId}/announcements`))).body.data[0].id;
    expect((await other.agent.delete(api(`/announcements/${id}`))).status).toBe(403);
    expect((await owner.agent.delete(api(`/announcements/${id}`))).status).toBe(200);
  });
});

describe("ratings and reviews", () => {
  it("only enrolled students can review, with a 1 to 5 rating", async () => {
    expect((await stranger.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 5 })).status).toBe(403);
    expect((await owner.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 5 })).status).toBe(403);
    expect((await student.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 6 })).status).toBe(400);
    expect((await student.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 0 })).status).toBe(400);
    expect((await student.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 4.5 })).status).toBe(400);
  });

  it("keeps one review per student (a second PUT edits it) and computes the average", async () => {
    await student.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 5, comment: "Great" });
    await student.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 3, comment: "Changed my mind" });
    await student2.agent.put(api(`/courses/${courseId}/reviews`)).send({ rating: 4 });
    const res = await anonymous().get(api(`/courses/${courseId}/reviews`));
    expect(res.body.data).toMatchObject({ count: 2, average: 3.5, canReview: false });
    const mine = await student.agent.get(api(`/courses/${courseId}/reviews`));
    expect(mine.body.data).toMatchObject({ canReview: true, mine: { rating: 3 } });
  });

  it("shows the rating on the course and removes a review on request", async () => {
    expect((await anonymous().get(api(`/courses/${courseId}`))).body.data).toMatchObject({ rating: 3.5, reviewCount: 2 });
    await student2.agent.delete(api(`/courses/${courseId}/reviews/mine`));
    expect((await anonymous().get(api(`/courses/${courseId}/reviews`))).body.data.count).toBe(1);
  });
});

describe("reordering", () => {
  it("reorders modules, and rejects incomplete or duplicate lists", async () => {
    const [a, b] = moduleIds;
    expect((await owner.agent.patch(api(`/courses/${courseId}/modules/reorder`)).send({ moduleIds: [a] })).status).toBe(400);
    expect((await owner.agent.patch(api(`/courses/${courseId}/modules/reorder`)).send({ moduleIds: [a, a] })).status).toBe(400);
    expect((await other.agent.patch(api(`/courses/${courseId}/modules/reorder`)).send({ moduleIds: [b, a] })).status).toBe(403);
    expect((await owner.agent.patch(api(`/courses/${courseId}/modules/reorder`)).send({ moduleIds: [b, a] })).status).toBe(200);
    const detail = await owner.agent.get(api(`/courses/${courseId}`));
    expect(detail.body.data.modules.map((m: { id: string }) => m.id)).toEqual([b, a]);
  });

  it("reorders lessons and moves one into another module", async () => {
    const [m1, m2] = moduleIds;
    const [l1, l2, l3] = lessonIds;
    expect((await owner.agent.patch(api(`/modules/${m1}/lessons/reorder`)).send({ lessonIds: [l3, l2, l1] })).status).toBe(200);
    let detail = (await owner.agent.get(api(`/courses/${courseId}`))).body.data;
    const first = detail.modules.find((m: { id: string }) => m.id === m1);
    expect(first.lessons.map((l: { id: string }) => l.id)).toEqual([l3, l2, l1]);

    expect((await owner.agent.patch(api(`/modules/${m2}/lessons/reorder`)).send({ lessonIds: [l1] })).status).toBe(200);
    detail = (await owner.agent.get(api(`/courses/${courseId}`))).body.data;
    expect(detail.modules.find((m: { id: string }) => m.id === m2).lessons.map((l: { id: string }) => l.id)).toEqual([l1]);
    expect(detail.modules.find((m: { id: string }) => m.id === m1).lessons.map((l: { id: string }) => l.id)).toEqual([l3, l2]);
  });

  it("refuses lessons from another course and non-owners", async () => {
    const foreign = await createCourse(other.user._id, { status: "published" });
    const [m1] = moduleIds;
    expect((await owner.agent.patch(api(`/modules/${m1}/lessons/reorder`)).send({ lessonIds: [foreign.lessons[0].id] })).status).toBe(400);
    expect((await other.agent.patch(api(`/modules/${m1}/lessons/reorder`)).send({ lessonIds: [] })).status).toBe(403);
    expect((await student.agent.patch(api(`/modules/${m1}/lessons/reorder`)).send({ lessonIds: [] })).status).toBe(403);
  });
});

describe("notifications", () => {
  it("lists, marks one read, marks all read, and cannot touch someone else's", async () => {
    const list = await student.agent.get(api("/notifications"));
    expect(list.body.data.unread).toBeGreaterThan(0);
    const id = list.body.data.items[0].id;
    expect((await other.agent.patch(api(`/notifications/${id}/read`))).status).toBe(404);
    expect((await student.agent.patch(api(`/notifications/${id}/read`))).status).toBe(200);
    await student.agent.patch(api("/notifications/read-all"));
    expect((await student.agent.get(api("/notifications"))).body.data.unread).toBe(0);
  });
});
