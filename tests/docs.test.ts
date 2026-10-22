import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { openApiSpec } from "../src/docs/openapi.js";
import { api, anonymous } from "./factory.js";

/** Finds every `xxxRouter.<method>("/path"` in the source and returns "METHOD /path" with {param} syntax. */
function routesInSource() {
  const prefix: Record<string, string> = { authRouter: "/auth", usersRouter: "/users" };
  const found = new Set<string>(["GET /health"]); // defined inline in app.ts
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".routes.ts")) {
        const source = readFileSync(full, "utf8");
        for (const m of source.matchAll(/(\w+Router)\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
          found.add(`${m[2].toUpperCase()} ${(prefix[m[1]] ?? "") + m[3].replace(/:(\w+)/g, "{$1}")}`);
        }
      }
    }
  };
  walk(join(process.cwd(), "src", "modules"));
  return found;
}

function routesInSpec() {
  const found = new Set<string>();
  for (const [path, ops] of Object.entries(openApiSpec.paths)) for (const method of Object.keys(ops)) found.add(`${method.toUpperCase()} ${path}`);
  return found;
}

describe("OpenAPI document", () => {
  it("is a valid OpenAPI 3 definition", async () => {
    await expect(SwaggerParser.validate(structuredClone(openApiSpec) as never)).resolves.toBeDefined();
  });

  it("documents every route in the code", () => {
    const missing = [...routesInSource()].filter((r) => !routesInSpec().has(r));
    expect(missing, `undocumented routes:\n${missing.join("\n")}`).toEqual([]);
  });

  it("documents no route that does not exist", () => {
    const stale = [...routesInSpec()].filter((r) => !routesInSource().has(r));
    expect(stale, `documented but missing in code:\n${stale.join("\n")}`).toEqual([]);
  });

  it("describes request bodies from the real validation schemas", () => {
    const login = openApiSpec.paths["/auth/login"].post as {
      requestBody: { content: { "application/json": { schema: { required: string[]; additionalProperties: boolean } } } };
    };
    const schema = login.requestBody.content["application/json"].schema;
    expect(schema.required).toEqual(expect.arrayContaining(["email", "password"]));
    expect(schema.additionalProperties).toBe(false);
  });

  it("marks public endpoints as not needing authentication", () => {
    const catalog = openApiSpec.paths["/courses"].get as { security: unknown[] };
    const mine = openApiSpec.paths["/courses/mine"].get as { security: unknown[] };
    expect(catalog.security).toEqual([]);
    expect(mine.security).toEqual([{ cookieAuth: [] }]);
  });
});

describe("docs endpoints", () => {
  it("serves the spec as JSON and Swagger UI as HTML", async () => {
    const spec = await anonymous().get(api("/openapi.json"));
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe("3.0.3");
    const ui = await anonymous().get(api("/docs/"));
    expect(ui.status).toBe(200);
    expect(ui.headers["content-type"]).toMatch(/html/);
  });
});
