import { z } from "zod";

const questionFields = {
  type: z.enum(["multiple_choice", "true_false"]),
  prompt: z.string().trim().min(3),
  options: z.array(z.string().trim().min(1)).max(8).default([]),
  correctIndex: z.number().int().min(0),
  points: z.number().int().min(1).max(100).default(1),
};

const settings = {
  title: z.string().trim().min(2).max(120),
  instructions: z.string().trim().max(1000).optional(),
  timeLimitSeconds: z.number().int().min(30).max(10800).default(900),
  passMark: z.number().int().min(1).max(100).default(60),
  maxAttempts: z.number().int().min(1).max(20).default(3),
};

export const createQuizBody = z.object({ ...settings, questions: z.array(z.object(questionFields).strict()).min(1).max(100) }).strict();

// When editing, an existing question carries its id; a new one has none.
export const updateQuizBody = z
  .object({
    ...settings,
    questions: z
      .array(z.object({ id: z.string().optional(), ...questionFields }).strict())
      .min(1)
      .max(100),
  })
  .strict();

export const submitAttemptBody = z.object({ answers: z.array(z.object({ questionId: z.string(), optionId: z.string() }).strict()).max(200) }).strict();

export type CreateQuizInput = z.infer<typeof createQuizBody>;
export type UpdateQuizInput = z.infer<typeof updateQuizBody>;
export type QuestionInput = UpdateQuizInput["questions"][number];
export type AnswerInput = z.infer<typeof submitAttemptBody>["answers"][number];
