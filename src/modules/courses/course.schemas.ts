import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { httpUrl, httpsUrl } from "../../shared/schemas.js";
import { LEVELS } from "./course.model.js";

// Field definitions are shared, but "create" adds defaults while "update" must not.
// Defaults inside a partial update would silently overwrite untouched fields.

const courseFields = {
  title: z.string().trim().min(5).max(120),
  summary: z.string().trim().min(10).max(240),
  description: z.string().trim().min(30),
  categoryId: z.string().refine(isValidObjectId, "Invalid category"),
  level: z.enum(LEVELS),
  objectives: z.array(z.string().trim().min(1)).max(20),
  prerequisites: z.array(z.string().trim().min(1)).max(20),
  thumbnailUrl: httpsUrl.nullable(),
};

export const createCourseBody = z
  .object({
    ...courseFields,
    objectives: courseFields.objectives.default([]),
    prerequisites: courseFields.prerequisites.default([]),
    thumbnailUrl: courseFields.thumbnailUrl.optional(),
  })
  .strict();
export const updateCourseBody = z.object(courseFields).partial().strict();

const moduleFields = {
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500),
  order: z.number().int().min(0),
};
export const createModuleBody = z
  .object({ title: moduleFields.title, description: moduleFields.description.optional(), order: moduleFields.order.optional() })
  .strict();
export const updateModuleBody = z.object(moduleFields).partial().strict();

const lessonFields = {
  title: z.string().trim().min(2).max(120),
  type: z.enum(["text", "video"]),
  content: z.string(),
  videoUrl: httpUrl,
  order: z.number().int().min(0),
  isRequired: z.boolean(),
  estimatedMinutes: z.number().int().min(1).max(600),
};
export const createLessonBody = z
  .object({
    ...lessonFields,
    type: lessonFields.type.default("text"),
    content: lessonFields.content.default(""),
    videoUrl: lessonFields.videoUrl.optional(),
    order: lessonFields.order.optional(),
    isRequired: lessonFields.isRequired.default(true),
    estimatedMinutes: lessonFields.estimatedMinutes.default(10),
  })
  .strict();
export const updateLessonBody = z.object(lessonFields).partial().strict();

const objectId = z.string().refine(isValidObjectId, "Invalid id");
export const reorderModulesBody = z.object({ moduleIds: z.array(objectId).min(1) }).strict();
export const reorderLessonsBody = z.object({ lessonIds: z.array(objectId).max(500) }).strict();
export const rejectCourseBody = z.object({ note: z.string().trim().min(3, "A moderation note is required").max(1000) }).strict();

export type CreateCourseInput = z.infer<typeof createCourseBody>;
export type UpdateCourseInput = z.infer<typeof updateCourseBody>;
