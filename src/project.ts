import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createProject, normalizeProject, type ProjectDocumentV1, stableStringify, validateProject } from "./model.js";

export async function readProject(path: string): Promise<ProjectDocumentV1> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<ProjectDocumentV1>;
  const project = normalizeProject(raw);
  const errors = validateProject(project);
  if (errors.length > 0) throw new Error(`invalid project: ${errors.join("; ")}`);
  return project;
}

export async function writeProject(path: string, project: ProjectDocumentV1): Promise<void> {
  const errors = validateProject(project);
  if (errors.length > 0) throw new Error(`refusing to write invalid project: ${errors.join("; ")}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stableStringify(project)}\n`, "utf8");
}

export async function ensureProject(path: string, id = "project-local"): Promise<ProjectDocumentV1> {
  try {
    return await readProject(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const project = createProject(id);
    await writeProject(path, project);
    return project;
  }
}
