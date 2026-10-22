import { Schema, model } from "mongoose";

const quizSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    instructions: { type: String, trim: true },
    timeLimitSeconds: { type: Number, default: 900, min: 30 },
    passMark: { type: Number, default: 60, min: 1, max: 100 }, // percent
    maxAttempts: { type: Number, default: 3, min: 1 },
    status: { type: String, enum: ["draft", "published"], default: "published" },
  },
  { timestamps: true },
);
export const Quiz = model("Quiz", quizSchema);

const questionSchema = new Schema({
  quizId: { type: Schema.Types.ObjectId, ref: "Quiz", required: true, index: true },
  type: { type: String, enum: ["multiple_choice", "true_false"], required: true },
  prompt: { type: String, required: true, trim: true },
  options: { type: [new Schema({ id: String, text: String }, { _id: false })], default: [] },
  // Never selected by default: correct answers must not reach students before submission.
  correctOptionId: { type: String, required: true, select: false },
  points: { type: Number, default: 1, min: 1 },
  order: { type: Number, default: 0 },
});
export const Question = model("Question", questionSchema);

const attemptSchema = new Schema(
  {
    quizId: { type: Schema.Types.ObjectId, ref: "Quiz", required: true },
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    attemptNumber: { type: Number, required: true },
    startedAt: { type: Date, default: Date.now },
    submittedAt: Date,
    answers: {
      type: [new Schema({ questionId: Schema.Types.ObjectId, optionId: String, correct: Boolean, points: Number }, { _id: false })],
      default: [],
    },
    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    passed: { type: Boolean, default: false },
    status: { type: String, enum: ["in_progress", "submitted"], default: "in_progress" },
  },
  { timestamps: true },
);
attemptSchema.index({ quizId: 1, studentId: 1, attemptNumber: 1 }, { unique: true });
export const QuizAttempt = model("QuizAttempt", attemptSchema);

const assignmentSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    instructions: { type: String, required: true, trim: true },
    dueAt: { type: Date, required: true },
    maxPoints: { type: Number, default: 100, min: 1 },
    allowResubmission: { type: Boolean, default: false },
  },
  { timestamps: true },
);
assignmentSchema.index({ dueAt: 1 });
export const Assignment = model("Assignment", assignmentSchema);

const submissionSchema = new Schema(
  {
    assignmentId: { type: Schema.Types.ObjectId, ref: "Assignment", required: true },
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    textResponse: { type: String, trim: true },
    // Link to the work (e.g. a shared file). Binary uploads need object storage, which is not configured yet.
    fileUrl: String,
    submittedAt: { type: Date, default: Date.now },
    isLate: { type: Boolean, default: false },
    status: { type: String, enum: ["submitted", "graded"], default: "submitted" },
    version: { type: Number, default: 1 },
    grade: {
      pointsAwarded: Number,
      feedback: String,
      gradedBy: { type: Schema.Types.ObjectId, ref: "User" },
      gradedAt: Date,
    },
  },
  { timestamps: true },
);
submissionSchema.index({ assignmentId: 1, studentId: 1 }, { unique: true });
export const Submission = model("Submission", submissionSchema);
