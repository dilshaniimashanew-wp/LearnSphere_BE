import { describe, expect, it } from "vitest";
import { assertResetAllowed } from "../../src/scripts/seed-demo.js";

describe("assertResetAllowed", () => {
  it("refuses in production, even with --yes", () => {
    expect(() => assertResetAllowed("production", ["--reset", "--yes"])).toThrow(/production/);
  });

  it("requires explicit confirmation", () => {
    expect(() => assertResetAllowed("development", ["--reset"])).toThrow(/--yes/);
  });

  it("allows a confirmed reset outside production", () => {
    expect(() => assertResetAllowed("development", ["--reset", "--yes"])).not.toThrow();
    expect(() => assertResetAllowed(undefined, ["--reset", "--yes"])).not.toThrow();
  });
});
