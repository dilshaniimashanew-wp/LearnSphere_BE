import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { User } from "../src/modules/users/user.model.js";
import { PASSWORD, api, anonymous, createUser, loginAs, resetDb } from "./factory.js";

beforeAll(resetDb);

const valid = { name: "Test Person", email: "person@test.local", password: "Passw0rd!", role: "student" };

describe("registration", () => {
  it("creates a student, returns the public user and sets an HttpOnly cookie", async () => {
    const res = await anonymous().post(api("/auth/register")).send(valid);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: valid.email, role: "student", status: "active" });
    expect(res.body.data).not.toHaveProperty("passwordHash");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/i);
  });

  it("stores an Argon2id hash, never the plain password", async () => {
    const user = await User.findOne({ email: valid.email }).select("+passwordHash");
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user?.passwordHash).not.toContain(valid.password);
  });

  it("rejects a duplicate email, ignoring case", async () => {
    const res = await anonymous().post(api("/auth/register")).send({ ...valid, email: valid.email.toUpperCase() });
    expect(res.status).toBe(409);
  });

  it.each(["admin", "instructor-ish"])("rejects the role %s on public registration", async (role) => {
    const res = await anonymous().post(api("/auth/register")).send({ ...valid, email: `r-${role}@test.local`, role });
    expect(res.status).toBe(400);
    expect(await User.exists({ email: `r-${role}@test.local` })).toBeNull();
  });

  it("rejects unknown fields instead of silently accepting them", async () => {
    const res = await anonymous().post(api("/auth/register")).send({ ...valid, email: "x@test.local", status: "suspended" });
    expect(res.status).toBe(400);
  });

  it.each([
    ["too short", "Ab1"],
    ["no uppercase", "password1"],
    ["no number", "Password"],
  ])("rejects a weak password (%s)", async (_label, password) => {
    const res = await anonymous().post(api("/auth/register")).send({ ...valid, email: "weak@test.local", password });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("login and session", () => {
  it("signs in and returns the current user from /auth/me", async () => {
    const agent = await loginAs(valid.email, valid.password);
    const me = await agent.get(api("/auth/me"));
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(valid.email);
  });

  it("uses the same error for a wrong password and an unknown email", async () => {
    const wrong = await anonymous().post(api("/auth/login")).send({ email: valid.email, password: "WrongPass1" });
    const unknown = await anonymous().post(api("/auth/login")).send({ email: "nobody@test.local", password: "WrongPass1" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("refuses suspended accounts at login and on an existing session", async () => {
    const { user, email } = await createUser("student");
    const agent = await loginAs(email);
    user.status = "suspended";
    await user.save();
    expect((await agent.get(api("/auth/me"))).status).toBe(403);
    expect((await anonymous().post(api("/auth/login")).send({ email, password: PASSWORD })).status).toBe(403);
  });

  it("rejects missing, forged and malformed session cookies", async () => {
    expect((await anonymous().get(api("/auth/me"))).status).toBe(401);
    expect((await request(app).get(api("/auth/me")).set("Cookie", "ls_access=abc.def.ghi")).status).toBe(401);
  });

  it("logs out by clearing the cookie", async () => {
    const { email } = await createUser("student");
    const agent = await loginAs(email);
    await agent.post(api("/auth/logout"));
    expect((await agent.get(api("/auth/me"))).status).toBe(401);
  });

  it("answers forgot-password identically for known and unknown emails", async () => {
    const known = await anonymous().post(api("/auth/forgot-password")).send({ email: valid.email });
    const unknown = await anonymous().post(api("/auth/forgot-password")).send({ email: "ghost@test.local" });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });
});

describe("profile", () => {
  it("updates the name and changes the password (old password stops working)", async () => {
    const { email } = await createUser("student");
    const agent = await loginAs(email);
    expect((await agent.patch(api("/users/me")).send({ name: "New Name" })).body.data.name).toBe("New Name");

    expect((await agent.patch(api("/users/me/password")).send({ currentPassword: "bad", newPassword: "NewPassw0rd" })).status).toBe(401);
    expect((await agent.patch(api("/users/me/password")).send({ currentPassword: PASSWORD, newPassword: "NewPassw0rd" })).status).toBe(200);
    expect((await anonymous().post(api("/auth/login")).send({ email, password: PASSWORD })).status).toBe(401);
    expect((await anonymous().post(api("/auth/login")).send({ email, password: "NewPassw0rd" })).status).toBe(200);
  });

  it("cannot escalate the role through the profile endpoint", async () => {
    const { email } = await createUser("student");
    const agent = await loginAs(email);
    expect((await agent.patch(api("/users/me")).send({ role: "admin" })).status).toBe(400);
  });

  it("accepts a small image avatar and rejects scripts and oversized data", async () => {
    const { email } = await createUser("student");
    const agent = await loginAs(email);
    const tiny = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD";
    expect((await agent.patch(api("/users/me")).send({ avatarUrl: tiny })).body.data.avatarUrl).toBe(tiny);
    expect((await agent.patch(api("/users/me")).send({ avatarUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await agent.patch(api("/users/me")).send({ avatarUrl: "data:text/html;base64,PHNjcmlwdD4=" })).status).toBe(400);
    expect((await agent.patch(api("/users/me")).send({ avatarUrl: `data:image/jpeg;base64,${"A".repeat(80_000)}` })).status).toBe(400);
    expect((await agent.patch(api("/users/me")).send({ avatarUrl: null })).body.data.avatarUrl).toBeUndefined();
  });
});
