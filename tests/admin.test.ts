import { beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, api, anonymous, createCategory, createCourse, resetDb, signedIn } from "./factory.js";

let admin: Awaited<ReturnType<typeof signedIn>>;
let instructor: Awaited<ReturnType<typeof signedIn>>;
let student: Awaited<ReturnType<typeof signedIn>>;

beforeAll(async () => {
  await resetDb();
  admin = await signedIn("admin");
  instructor = await signedIn("instructor");
  student = await signedIn("student");
});

describe("user management", () => {
  it("lists, searches and filters users with pagination", async () => {
    const all = await admin.agent.get(api("/admin/users?pageSize=2"));
    expect(all.body.data).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(all.body.data.items).toHaveLength(2);
    expect(JSON.stringify(all.body)).not.toMatch(/passwordHash/);
    expect((await admin.agent.get(api(`/admin/users?q=${encodeURIComponent(student.email)}`))).body.data.total).toBe(1);
    expect((await admin.agent.get(api("/admin/users?role=instructor"))).body.data.total).toBe(1);
    expect((await admin.agent.get(api("/admin/users?q=%5B"))).status).toBe(200);
  });

  it("suspends and reactivates a user; suspended users cannot sign in; admins cannot suspend themselves", async () => {
    expect((await admin.agent.patch(api(`/admin/users/${student.user.id}/status`)).send({ status: "suspended" })).body.data.status).toBe("suspended");
    expect((await anonymous().post(api("/auth/login")).send({ email: student.email, password: PASSWORD })).status).toBe(403);
    expect((await admin.agent.patch(api(`/admin/users/${student.user.id}/status`)).send({ status: "active" })).body.data.status).toBe("active");
    expect((await admin.agent.patch(api(`/admin/users/${admin.user.id}/status`)).send({ status: "suspended" })).status).toBe(403);
    expect((await admin.agent.patch(api(`/admin/users/${student.user.id}/status`)).send({ status: "banned" })).status).toBe(400);
  });
});

describe("categories", () => {
  it("creates unique categories (case-insensitive) and only deletes empty ones", async () => {
    const created = await admin.agent.post(api("/admin/categories")).send({ name: "Languages" });
    expect(created.status).toBe(201);
    expect((await admin.agent.post(api("/admin/categories")).send({ name: "languages" })).status).toBe(409);

    const used = await createCategory("In use");
    await createCourse(instructor.user._id, { status: "published" });
    const cat = (await admin.agent.get(api("/admin/categories"))).body.data.find(
      (c: { name: string; courses: number }) => c.name !== "Languages" && c.courses > 0,
    );
    expect(cat).toBeTruthy();
    expect((await admin.agent.delete(api(`/admin/categories/${cat.id}`))).status).toBe(400);
    expect((await admin.agent.delete(api(`/admin/categories/${created.body.data.id}`))).status).toBe(200);
    expect(used.id).toBeTruthy();
  });

  it("lists active categories publicly", async () => {
    const res = await anonymous().get(api("/categories"));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

describe("audit logs and analytics", () => {
  it("records moderation and user actions without secrets", async () => {
    const { course } = await createCourse(instructor.user._id, { status: "pending_review" });
    await admin.agent.patch(api(`/admin/courses/${course.id}/approve`));
    const logs = (await admin.agent.get(api("/admin/audit-logs"))).body.data;
    const actions = logs.items.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["course.approve", "user.suspend", "user.reactivate", "category.create"]));
    expect(JSON.stringify(logs)).not.toMatch(/password|token|secret/i);
  });

  it("returns platform, instructor and student summaries to the right roles", async () => {
    expect((await admin.agent.get(api("/admin/analytics"))).body.data).toMatchObject({ users: 3, publishedCourses: expect.any(Number) });
    expect((await instructor.agent.get(api("/instructor/analytics"))).body.data.courses).toBeGreaterThan(0);
    expect((await student.agent.get(api("/student/summary"))).body.data).toMatchObject({ active: 0, completed: 0 });
    expect((await instructor.agent.get(api("/admin/analytics"))).status).toBe(403);
  });
});

describe("platform behaviour", () => {
  it("returns the standard error envelope for unknown routes and bad JSON", async () => {
    const missing = await anonymous().get(api("/no-such-route"));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: "NOT_FOUND", details: [] });
    const bad = await anonymous().post(api("/auth/login")).set("Content-Type", "application/json").send("{not json");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    const huge = await anonymous()
      .post(api("/auth/login"))
      .send({ email: "a@b.co", password: "x".repeat(200_000) });
    expect(huge.status).toBe(413);
  });

  it("reports health and sets security headers", async () => {
    const res = await anonymous().get(api("/health"));
    expect(res.body.data).toEqual({ status: "ok", db: "connected" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("only allows the configured web origin through CORS", async () => {
    const allowed = await anonymous().options(api("/auth/login")).set("Origin", "http://localhost:3000").set("Access-Control-Request-Method", "POST");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const blocked = await anonymous().options(api("/auth/login")).set("Origin", "http://evil.test").set("Access-Control-Request-Method", "POST");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
