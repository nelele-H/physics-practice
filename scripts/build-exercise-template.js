import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "examples", "exercise-package");
const outputDirectory = path.join(root, "public", "downloads");
const output = path.join(outputDirectory, "exercise-package-template.zip");

const zip = new AdmZip();
for (const filename of ["exercise.json", "questions.md", "answers.md", "图片使用说明.md"]) {
  zip.addLocalFile(path.join(source, filename), "", filename);
}
fs.mkdirSync(outputDirectory, { recursive: true });
zip.writeZip(output);
console.log(`题库模板已生成：${output}`);
