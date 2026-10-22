import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const COURSE_STATUSES = ["draft", "pending_review", "published", "rejected", "archived"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];
export const LEVELS = ["beginner", "intermediate", "advanced"] as const;

const categorySchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, unique: true },
    description: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Category = model("Category", categorySchema);

const courseSchema = new Schema(
  {
    instructorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true },
    summary: { type: String, required: true, trim: true, maxlength: 240 },
    description: { type: String, required: true, trim: true },
    thumbnailUrl: String,
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    level: { type: String, enum: LEVELS, default: "beginner", required: true },
    objectives: { type: [String], default: [] },
    prerequisites: { type: [String], default: [] },
    status: { type: String, enum: COURSE_STATUSES, default: "draft", required: true },
    moderationNote: String,
    publishedAt: Date,
  },
  { timestamps: true },
);
courseSchema.index({ status: 1, categoryId: 1 });
export type CourseDoc = HydratedDocument<InferSchemaType<typeof courseSchema>>;
export const Course = model("Course", courseSchema);

const moduleSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const CourseModule = model("Module", moduleSchema);

const lessonSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    moduleId: { type: Schema.Types.ObjectId, ref: "Module", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ["text", "video"], default: "text" },
    content: { type: String, default: "" },
    videoUrl: String,
    order: { type: Number, default: 0 },
    isRequired: { type: Boolean, default: true },
    estimatedMinutes: { type: Number, default: 10, min: 1 },
  },
  { timestamps: true },
);
export const Lesson = model("Lesson", lessonSchema);
