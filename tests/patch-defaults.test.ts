import { beforeAll, describe, expect, it } from "vitest";
import { api, createCategory, resetDb, signedIn } from "./factory.js";

let owner: Awaited<ReturnType<typeof signedIn>>;
let courseId: string;
let moduleId: string;
let lessonId: string;

beforeAll(async () => {
  await resetDb();
  owner = await signedIn("instructor");
  const category = await createCategory("Patch");
  const course = await owner.agent.post(api("/courses")).send({
    title: "Patch semantics",
    summary: "A summary long enough.",
    description: "A description that is certainly longer than thirty characters.",
    categoryId: String(category.id),
    level: "advanced",
    objectives: ["Keep me"],
    prerequisites: ["Keep me too"],
  });
  courseId = course.body.data.id;
  moduleId = (await owner.agent.post(api(`/courses/${courseId}/modules`)).send({ title: "Module", description: "Keep this" })).body.data.id;
  lessonId = (
    await owner.agent
      .post(api(`/modules/${moduleId}/lessons`))
      .send({ title: "Lesson", content: "Precious content", estimatedMinutes: 42, isRequired: false, type: "text" })
  ).body.data.id;
});

describe("partial updates only change the fields that were sent", () => {
  it("course: editing the title keeps objectives, prerequisites and level", async () => {
    const res = await owner.agent.patch(api(`/courses/${courseId}`)).send({ title: "Renamed course" });
    expect(res.body.data).toMatchObject({ title: "Renamed course", objectives: ["Keep me"], prerequisites: ["Keep me too"], level: "advanced" });
  });

  it("lesson: editing the title keeps content, minutes, required flag and type", async () => {
    await owner.agent.patch(api(`/lessons/${lessonId}`)).send({ title: "Renamed lesson" });
    const detail = (await owner.agent.get(api(`/courses/${courseId}/lessons`))).body.data;
    expect(detail.modules[0].lessons[0]).toMatchObject({ title: "Renamed lesson", content: "Precious content", minutes: 42, isRequired: false, type: "text" });
  });

  it("module: editing the title keeps the description", async () => {
    await owner.agent.patch(api(`/modules/${moduleId}`)).send({ title: "Renamed module" });
    const detail = (await owner.agent.get(api(`/courses/${courseId}`))).body.data;
    expect(detail.modules[0]).toMatchObject({ title: "Renamed module", description: "Keep this" });
  });
});
