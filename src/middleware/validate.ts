import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { badRequest } from "../shared/errors.js";

/** Validates req.body against a Zod schema and replaces it with the parsed (stripped) value. */
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
      return next(badRequest("Please check the submitted fields", details));
    }
    req.body = result.data;
    next();
  };
}
