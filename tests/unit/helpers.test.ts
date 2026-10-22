import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AppError } from "../../src/shared/errors.js";
import { escapeRegex, oid, paginate, slugify, uniqueSlug } from "../../src/shared/helpers.js";

describe("slugify", () => {
  it.each([
    ["Modern Web Development", "modern-web-development"],
    ["  Hello,   World!! ", "hello-world"],
    ["C++ & C#", "c-c"],
    ["", ""],
  ])("%j -> %j", (input, expected) => expect(slugify(input)).toBe(expected));

  it("caps the length at 60 characters", () => expect(slugify("a".repeat(200)).length).toBe(60));
});

describe("uniqueSlug", () => {
  it("adds a random suffix so equal titles do not collide", () => {
    expect(uniqueSlug("Same title")).not.toBe(uniqueSlug("Same title"));
    expect(uniqueSlug("Same title")).toMatch(/^same-title-[0-9a-f]{4}$/);
    expect(uniqueSlug("!!!")).toMatch(/^item-[0-9a-f]{4}$/);
  });
});

describe("paginate", () => {
  it("defaults, clamps and computes skip", () => {
    expect(paginate({})).toEqual({ page: 1, pageSize: 12, skip: 0 });
    expect(paginate({ page: "3", pageSize: "10" })).toEqual({ page: 3, pageSize: 10, skip: 20 });
    expect(paginate({ page: "-4", pageSize: "100000" })).toEqual({ page: 1, pageSize: 100, skip: 0 });
    expect(paginate({ page: "abc", pageSize: "0" })).toMatchObject({ page: 1, pageSize: 12 });
  });
});

describe("escapeRegex", () => {
  it("neutralises regex metacharacters so user input cannot become a pattern", () => {
    const input = "a.b*c(d)[e]";
    expect(new RegExp(escapeRegex(input)).test(input)).toBe(true);
    expect(new RegExp(escapeRegex(".*")).test("anything")).toBe(false);
  });
});

describe("oid", () => {
  it("accepts a valid id string or ObjectId", () => {
    const id = new Types.ObjectId();
    expect(oid(id.toHexString())).toBe(id.toHexString());
    expect(oid(id)).toBe(id.toHexString());
  });

  it.each(["not-an-id", "", undefined, null, 42, ["x"]])("treats %j as not found", (bad) => {
    expect(() => oid(bad)).toThrow(AppError);
    try {
      oid(bad);
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });
});
