import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { buildQuestionDocs, deadlineOf, gradeAnswers, isPassing, percentOf, toPublicQuestion } from "../../src/modules/assessments/quiz.service.js";

const q = (points: number, correctOptionId: string) => ({ _id: new Types.ObjectId(), points, correctOptionId });

describe("gradeAnswers", () => {
  const questions = [q(2, "a"), q(1, "b"), q(3, "c")];
  const id = (i: number) => String(questions[i]._id);

  it("awards points only for correct answers", () => {
    const r = gradeAnswers(questions, [
      { questionId: id(0), optionId: "a" },
      { questionId: id(1), optionId: "a" },
      { questionId: id(2), optionId: "c" },
    ]);
    expect(r.score).toBe(5);
    expect(r.maxScore).toBe(6);
    expect(r.graded.map((g) => g.correct)).toEqual([true, false, true]);
  });

  it("scores 0 with no answers but still reports the maximum", () => {
    expect(gradeAnswers(questions, [])).toMatchObject({ score: 0, maxScore: 6 });
  });

  it("ignores answers for unknown questions and duplicate-question tampering", () => {
    const r = gradeAnswers(questions, [
      { questionId: "not-a-question", optionId: "a" },
      { questionId: id(0), optionId: "a" },
      { questionId: id(0), optionId: "z" },
    ]);
    expect(r.score).toBe(0); // the last answer for a question wins, and "z" is wrong
  });

  it("gives full marks for a perfect paper", () => {
    const r = gradeAnswers(
      questions,
      questions.map((x, i) => ({ questionId: id(i), optionId: x.correctOptionId })),
    );
    expect(r.score).toBe(r.maxScore);
  });

  it("handles an empty quiz", () => expect(gradeAnswers([], [])).toMatchObject({ score: 0, maxScore: 0 }));
});

describe("pass mark", () => {
  it.each([
    [3, 5, 60, true], // exactly 60%
    [2, 5, 60, false],
    [5, 5, 100, true],
    [0, 0, 1, false], // an empty quiz can never be passed
    [1, 3, 33, true],
    [1, 3, 34, false],
  ])("score %i/%i with pass mark %i%% -> %s", (score, max, mark, expected) => expect(isPassing(score, max, mark)).toBe(expected));

  it("rounds percentages and tolerates a zero maximum", () => {
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(0, 0)).toBe(0);
  });
});

describe("deadlineOf", () => {
  it("adds the time limit to the start time", () => {
    const start = new Date("2026-01-01T10:00:00Z");
    expect(deadlineOf(start, 90).toISOString()).toBe("2026-01-01T10:01:30.000Z");
  });
});

describe("buildQuestionDocs", () => {
  const base = { prompt: "A question", points: 1 };

  it("assigns letter option ids, an order and the correct option", () => {
    const [m] = buildQuestionDocs([{ ...base, type: "multiple_choice", options: ["x", "y", "z"], correctIndex: 2 }]);
    expect(m.doc.options).toEqual([
      { id: "a", text: "x" },
      { id: "b", text: "y" },
      { id: "c", text: "z" },
    ]);
    expect(m.doc.correctOptionId).toBe("c");
    expect(m.doc.order).toBe(0);
  });

  it("forces True/False options regardless of input", () => {
    const [t] = buildQuestionDocs([{ ...base, type: "true_false", options: ["ignored"], correctIndex: 1 }]);
    expect(t.doc.options.map((o) => o.text)).toEqual(["True", "False"]);
    expect(t.doc.correctOptionId).toBe("b");
  });

  it("rejects too few options and an out-of-range correct answer", () => {
    expect(() => buildQuestionDocs([{ ...base, type: "multiple_choice", options: ["only"], correctIndex: 0 }])).toThrow(/at least two options/);
    expect(() => buildQuestionDocs([{ ...base, type: "multiple_choice", options: ["a", "b"], correctIndex: 5 }])).toThrow(/invalid correct answer/);
    expect(() => buildQuestionDocs([{ ...base, type: "true_false", options: [], correctIndex: 2 }])).toThrow(/invalid correct answer/);
  });

  it("keeps the id of an existing question", () => {
    const [m] = buildQuestionDocs([{ ...base, id: "abc", type: "true_false", options: [], correctIndex: 0 }]);
    expect(m.id).toBe("abc");
  });
});

describe("toPublicQuestion", () => {
  it("never includes the answer key", () => {
    const pub = toPublicQuestion({ _id: "1", type: "true_false", prompt: "p", options: [{ id: "a", text: "True" }], points: 1, correctOptionId: "a" } as never);
    expect(pub).not.toHaveProperty("correctOptionId");
  });
});
