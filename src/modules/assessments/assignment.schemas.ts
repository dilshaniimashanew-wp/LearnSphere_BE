import { z } from "zod";
import { httpUrl } from "../../shared/schemas.js";

export const createAssignmentBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    instructions: z.string().trim().min(5),
    dueAt: z.coerce.date(),
    maxPoints: z.number().int().min(1).max(1000).default(100),
    allowResubmission: z.boolean().default(false),
  })
  .strict();

export const submissionBody = z
  .object({ textResponse: z.string().trim().max(10000).optional(), fileUrl: httpUrl.optional() })
  .strict()
  .refine((v) => v.textResponse || v.fileUrl, { message: "Provide a written response or a file link" });

export const gradeBody = z.object({ pointsAwarded: z.number().min(0), feedback: z.string().trim().max(2000).default("") }).strict();

export type CreateAssignmentInput = z.infer<typeof createAssignmentBody>;
export type SubmissionInput = z.infer<typeof submissionBody>;
export type GradeInput = z.infer<typeof gradeBody>;
