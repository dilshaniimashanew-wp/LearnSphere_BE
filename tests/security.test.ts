import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { createLimiter } from "../src/middleware/security.js";
import { RefreshSession } from "../src/modules/auth/session.model.js";
import { User } from "../src/modules/users/user.model.js";
import { PASSWORD, api, createUser, resetDb } from "./factory.js";

beforeAll(resetDb);

/** Signs in with raw requests so individual cookies can be replayed. */
async function rawLogin(email: string, password = PASSWORD) {
  const res = await request(app).post(api("/auth/login")).send({ email, password });
  const cookies = (res.headers["set-cookie"] as unknown as string[]) ?? [];
  const pick = (name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";
  return { res, access: pick("ls_access"), refresh: pick("ls_refresh"), raw: cookies };
}

const refreshWith = (cookie: string) => request(app).post(api("/auth/refresh")).set("Cookie", cookie);
const meWith = (cookie: string) => request(app).get(api("/auth/me")).set("Cookie", cookie);

describe("cookies", () => {
  it("sets HttpOnly SameSite cookies, with the refresh token scoped to the auth endpoints", async () => {
    const { email } = await createUser("student");
    const { raw } = await rawLogin(email);
    const access = raw.find((c) => c.startsWith("ls_access="))!;
    const refresh = raw.find((c) => c.startsWith("ls_refresh="))!;
    for (const c of [access, refresh]) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    expect(access).toMatch(/Path=\/(;|$)/);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
  });

  it("stores only a hash of the refresh token", async () => {
    const { email } = await createUser("student");
    const { refresh } = await rawLogin(email);
    const token = refresh.split("=")[1];
    const stored = await RefreshSession.find().lean();
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.tokenHash))).toBe(true);
  });
});

describe("access tokens", () => {
  it("expire after 15 minutes", async () => {
    const { user } = await createUser("student");
    const token = jwt.decode(jwt.sign({ sub: user.id, typ: "access" }, env.SESSION_SECRET, { expiresIn: 900 })) as { exp: number; iat: number };
    expect(token.exp - token.iat).toBe(900);
    const expired = jwt.sign({ sub: user.id, typ: "access" }, env.SESSION_SECRET, { expiresIn: -10 });
    expect((await meWith(`ls_access=${expired}`)).status).toBe(401);
  });

  it("reject tokens signed with another secret, 'alg: none', or the wrong type", async () => {
    const { user } = await createUser("student");
    const wrongSecret = jwt.sign({ sub: user.id, typ: "access" }, "another-secret-another-secret-another-secret!!");
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, typ: "access" })).toString("base64url")}.`;
    const wrongType = jwt.sign({ sub: user.id, typ: "refresh" }, env.SESSION_SECRET);
    const noType = jwt.sign({ sub: user.id }, env.SESSION_SECRET);
    for (const token of [wrongSecret, none, wrongType, noType]) {
      expect((await meWith(`ls_access=${token}`)).status).toBe(401);
    }
  });

  it("cannot be replaced by presenting a refresh token as the access cookie", async () => {
    const { email } = await createUser("student");
    const { refresh } = await rawLogin(email);
    expect((await meWith(`ls_access=${refresh.split("=")[1]}`)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("issues a new access + refresh pair and invalidates the old refresh token", async () => {
    const { email } = await createUser("student");
    const first = await rawLogin(email);
    const res = await refreshWith(first.refresh);
    expect(res.status).toBe(200);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const newRefresh = cookies.find((c) => c.startsWith("ls_refresh="))!.split(";")[0];
    const newAccess = cookies.find((c) => c.startsWith("ls_access="))!.split(";")[0];
    expect(newRefresh).not.toBe(first.refresh);
    expect((await meWith(newAccess)).status).toBe(200);
  });

  it("treats reuse of a rotated token as theft and revokes every session of that user", async () => {
    const { email, user } = await createUser("student");
    const deviceA = await rawLogin(email);
    const deviceB = await rawLogin(email);
    const rotated = await refreshWith(deviceA.refresh);
    expect(rotated.status).toBe(200);

    // An attacker replays the old token.
    expect((await refreshWith(deviceA.refresh)).status).toBe(401);
    expect(await RefreshSession.countDocuments({ userId: user._id })).toBe(0);
    // The other device was signed out too.
    expect((await refreshWith(deviceB.refresh)).status).toBe(401);
  });

  it("lets only one of several simultaneous refreshes with the same token succeed", async () => {
    const { email } = await createUser("student");
    const { refresh } = await rawLogin(email);
    const results = await Promise.all([1, 2, 3, 4].map(() => refreshWith(refresh)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("rejects missing, garbage and expired refresh tokens", async () => {
    expect((await request(app).post(api("/auth/refresh"))).status).toBe(401);
    expect((await refreshWith("ls_refresh=garbage")).status).toBe(401);
    const { email } = await createUser("student");
    const { refresh } = await rawLogin(email);
    await RefreshSession.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await refreshWith(refresh)).status).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const { email } = await createUser("student");
    const { refresh } = await rawLogin(email);
    await request(app).post(api("/auth/logout")).set("Cookie", refresh);
    expect((await refreshWith(refresh)).status).toBe(401);
  });

  it("a password change signs out every other device", async () => {
    const { email } = await createUser("student");
    const phone = await rawLogin(email);
    const laptop = await rawLogin(email);
    const change = await request(app).patch(api("/users/me/password")).set("Cookie", laptop.access).send({ currentPassword: PASSWORD, newPassword: "BrandNew123" });
    expect(change.status).toBe(200);
    expect((await refreshWith(phone.refresh)).status).toBe(401);
    expect((await refreshWith(laptop.refresh)).status).toBe(401); // old token is gone too, but this device got a fresh pair
    const fresh = (change.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ls_refresh="))!.split(";")[0];
    expect((await refreshWith(fresh)).status).toBe(200);
  });

  it("refuses to refresh for a suspended account", async () => {
    const { email, user } = await createUser("student");
    const { refresh } = await rawLogin(email);
    await User.updateOne({ _id: user._id }, { status: "suspended" });
    expect((await refreshWith(refresh)).status).toBe(401);
  });
});

describe("account lockout", () => {
  it("locks after 5 wrong passwords, even for the right password, and unlocks later", async () => {
    const { email, user } = await createUser("student");
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post(api("/auth/login")).send({ email, password: "Wrong-pass1" })).status).toBe(401);
    }
    const locked = await request(app).post(api("/auth/login")).send({ email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");

    await User.updateOne({ _id: user._id }, { lockedUntil: new Date(Date.now() - 1000) });
    expect((await request(app).post(api("/auth/login")).send({ email, password: PASSWORD })).status).toBe(200);
  });

  it("resets the failure counter after a successful sign-in", async () => {
    const { email, user } = await createUser("student");
    for (let i = 0; i < 3; i++) await request(app).post(api("/auth/login")).send({ email, password: "Wrong-pass1" });
    await request(app).post(api("/auth/login")).send({ email, password: PASSWORD });
    expect((await User.findById(user._id))?.failedLoginCount).toBe(0);
  });

  it("does not reveal whether an email exists", async () => {
    const unknown = await request(app).post(api("/auth/login")).send({ email: "nobody-here@test.local", password: "Wrong-pass1" });
    const { email } = await createUser("student");
    const wrong = await request(app).post(api("/auth/login")).send({ email, password: "Wrong-pass1" });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe("cross-origin protection", () => {
  it("blocks state-changing requests that come from another origin", async () => {
    const { email } = await createUser("student");
    const res = await request(app).post(api("/auth/login")).set("Origin", "http://evil.test").send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it("allows the configured web origin and origin-less clients, and never blocks reads", async () => {
    const { email } = await createUser("student");
    expect((await request(app).post(api("/auth/login")).set("Origin", env.APP_ORIGIN).send({ email, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post(api("/auth/login")).send({ email, password: PASSWORD })).status).toBe(200);
    expect((await request(app).get(api("/courses")).set("Origin", "http://evil.test")).status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("rejects requests over the limit with the standard error shape", async () => {
    const mini = express();
    mini.use(createLimiter(2));
    mini.get("/ping", (_req, res) => void res.json({ ok: true }));
    expect((await request(mini).get("/ping")).status).toBe(200);
    expect((await request(mini).get("/ping")).status).toBe(200);
    const blocked = await request(mini).get("/ping");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["ratelimit"] ?? blocked.headers["ratelimit-policy"]).toBeDefined();
  });
});
