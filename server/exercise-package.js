import path from "node:path";
import AdmZip from "adm-zip";
import MarkdownIt from "markdown-it";
import katex from "katex";

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
});

const allowedAssetExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function fail(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function renderMarkdown(source) {
  const mathBlocks = [];
  const protectedSource = String(source).replace(
    /\$\$\s*([\s\S]*?)\s*\$\$/g,
    (_all, formula) => {
      const token = `MATHBLOCKTOKEN${mathBlocks.length}ENDTOKEN`;
      try {
        mathBlocks.push(
          katex.renderToString(formula.trim(), {
            displayMode: true,
            throwOnError: true,
            strict: "error",
          }),
        );
      } catch (error) {
        fail(`公式无法渲染：${error.message}`);
      }
      return `\n\n${token}\n\n`;
    },
  );

  let html = md.render(protectedSource);
  mathBlocks.forEach((mathHtml, index) => {
    html = html.replace(`<p>MATHBLOCKTOKEN${index}ENDTOKEN</p>`, mathHtml);
  });
  return html;
}

function renderInline(source) {
  return md.renderInline(String(source).trim());
}

function parseAttributes(raw) {
  const attributes = {};
  for (const match of String(raw ?? "").matchAll(
    /([A-Za-z][A-Za-z0-9_-]*)=("([^"]*)"|'([^']*)'|([^\s]+))/g,
  )) {
    attributes[match[1]] = match[3] ?? match[4] ?? match[5];
  }
  return attributes;
}

function validateLeafAttributes(attributes, label) {
  if (!attributes.id || !/^[a-z][a-z0-9_-]{0,39}$/.test(attributes.id)) {
    fail(`${label} 缺少有效 id；格式示例：{id=q2a type=numeric ...}`);
  }
  if (!["mcq", "numeric", "manual"].includes(attributes.type)) {
    fail(`${label} 的 type 必须是 mcq、numeric 或 manual。`);
  }
}

function parseNumericToken(rawToken) {
  const normalized = String(rawToken)
    .trim()
    .replace(/\\times|×/g, "*")
    .replace(/\s+/g, "")
    .replace(/\^\{([+-]?\d+)\}/g, "^$1");
  const match = normalized.match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\*10\^([+-]?\d+))?$/,
  );
  if (!match) return null;
  const mantissa = match[1];
  const exponent = Number(match[2] ?? 0);
  const value = Number(mantissa) * 10 ** exponent;
  if (!Number.isFinite(value)) return null;
  return {
    value,
    display: match[2] === undefined ? mantissa : `${mantissa}*10^${exponent}`,
    decimals: (mantissa.replace(/^[+-]/, "").split(".")[1] ?? "").length,
    exponent,
  };
}

function rewriteAssetLinks(markdown, slug) {
  return String(markdown).replace(
    /\((?:\.\/)?assets\/([A-Za-z0-9._/-]+)\)/g,
    (_all, assetPath) => `(/exercise-assets/${slug}/${assetPath})`,
  );
}

function parseOptions(body, label) {
  const matches = [...body.matchAll(/^([A-D])\.\s+/gm)];
  if (matches.length !== 4) {
    fail(`${label} 是选择题，但没有找到完整的 A、B、C、D 四个选项。`);
  }
  return {
    prompt: body.slice(0, matches[0].index).trim(),
    options: matches.map((match, index) => ({
      key: match[1],
      html: renderMarkdown(
        body.slice(match.index + match[0].length, matches[index + 1]?.index ?? body.length).trim(),
      ),
    })),
  };
}

function parseAnswerSections(answerSource) {
  const headings = [...answerSource.matchAll(/^#{3,4}\s+.*$/gm)];
  const answers = new Map();
  for (const [index, heading] of headings.entries()) {
    const attributeMatch = heading[0].match(/\{([^}]*)\}\s*$/);
    if (!attributeMatch) continue;
    const attributes = parseAttributes(attributeMatch[1]);
    if (!attributes.id) continue;
    if (answers.has(attributes.id)) fail(`答案文件中的 id=${attributes.id} 重复。`);
    answers.set(
      attributes.id,
      answerSource
        .slice(heading.index + heading[0].length, headings[index + 1]?.index ?? answerSource.length)
        .trim(),
    );
  }
  return answers;
}

function buildLeaf({
  slug,
  number,
  title,
  label,
  points,
  body,
  intro,
  attributes,
  answers,
  sortOrder,
}) {
  validateLeafAttributes(attributes, `第 ${label} 题`);
  const answerMarkdown = answers.get(attributes.id);
  if (!answerMarkdown) fail(`第 ${label} 题（id=${attributes.id}）缺少答案。`);

  const fullId = `${slug}-${attributes.id}`;
  const promptMarkdown = [intro, body].filter(Boolean).join("\n\n---\n\n");
  const answerHtml = renderMarkdown(rewriteAssetLinks(answerMarkdown, slug));

  if (attributes.type === "mcq") {
    const optionData = parseOptions(rewriteAssetLinks(body, slug), `第 ${label} 题`);
    const correct = answerMarkdown.match(/^Correct:\s*([A-D])\s*$/im)?.[1]?.toUpperCase();
    if (!correct) fail(`第 ${label} 题的答案必须包含 Correct: A/B/C/D。`);
    return {
      id: fullId,
      label,
      parentNumber: number,
      title,
      type: "mcq",
      inputMode: "mcq",
      maxPoints: points,
      promptHtml: renderMarkdown(optionData.prompt),
      options: optionData.options,
      correctValue: correct,
      numericValue: null,
      numericTolerance: null,
      requiredDecimals: null,
      unitLabel: null,
      answerHtml,
      sortOrder,
    };
  }

  if (attributes.type === "numeric") {
    const requiredDecimals = Number(attributes.decimals);
    const unit = String(attributes.unit ?? "").trim();
    if (!Number.isInteger(requiredDecimals) || requiredDecimals < 0 || requiredDecimals > 10) {
      fail(`第 ${label} 题必须指定 0～10 之间的 decimals。`);
    }
    if (!unit || unit.length > 45) fail(`第 ${label} 题必须指定 unit。`);
    const correctLine = answerMarkdown.match(/^Correct:\s*(.+?)\s*$/im)?.[1];
    const numeric = parseNumericToken(correctLine);
    if (!numeric) fail(`第 ${label} 题的答案必须包含纯数值 Correct:，例如 Correct: 12.0。`);
    if (numeric.decimals !== requiredDecimals) {
      fail(`第 ${label} 题的 Correct 小数位数与 decimals=${requiredDecimals} 不一致。`);
    }
    const toleranceLine = answerMarkdown.match(/^Tolerance:\s*(.+?)\s*$/im)?.[1];
    const tolerance = toleranceLine
      ? Number(toleranceLine)
      : 0.5000001 * 10 ** -requiredDecimals * 10 ** numeric.exponent;
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      fail(`第 ${label} 题的 Tolerance 必须是正数。`);
    }
    return {
      id: fullId,
      label,
      parentNumber: number,
      title,
      type: "manual",
      inputMode: "numeric",
      maxPoints: points,
      promptHtml: renderMarkdown(rewriteAssetLinks(promptMarkdown, slug)),
      options: [],
      correctValue: numeric.display,
      numericValue: numeric.value,
      numericTolerance: tolerance,
      requiredDecimals,
      unitLabel: unit,
      answerHtml,
      sortOrder,
    };
  }

  return {
    id: fullId,
    label,
    parentNumber: number,
    title,
    type: "manual",
    inputMode: "manual",
    maxPoints: points,
    promptHtml: renderMarkdown(rewriteAssetLinks(promptMarkdown, slug)),
    options: [],
    correctValue: null,
    numericValue: null,
    numericTolerance: null,
    requiredDecimals: null,
    unitLabel: null,
    answerHtml,
    sortOrder,
  };
}

function parseQuestions(questionSource, answerSource, metadata) {
  const blockMatches = [
    ...questionSource.matchAll(
      /^### Question\s+(\d+)(.*?)\[(\d+(?:\.\d+)?)\](?:\s*\{([^}]*)\})?\s*$/gm,
    ),
  ];
  if (!blockMatches.length) fail("questions.md 中没有找到题目。");
  const answers = parseAnswerSections(answerSource);
  const questions = [];
  const seenIds = new Set();

  for (const [blockIndex, block] of blockMatches.entries()) {
    const number = Number(block[1]);
    const title = block[2].trim();
    const parentPoints = Number(block[3]);
    const blockAttributes = parseAttributes(block[4]);
    const blockBody = questionSource
      .slice(block.index + block[0].length, blockMatches[blockIndex + 1]?.index ?? questionSource.length)
      .trim();
    const partMatches = [
      ...blockBody.matchAll(
        /^####\s+\(([^)]+)\)\s+\[(\d+(?:\.\d+)?)\]\s*\{([^}]*)\}\s*$/gm,
      ),
    ];

    if (!partMatches.length) {
      const leaf = buildLeaf({
        slug: metadata.slug,
        number,
        title,
        label: String(number),
        points: parentPoints,
        body: blockBody,
        intro: "",
        attributes: blockAttributes,
        answers,
        sortOrder: questions.length,
      });
      if (seenIds.has(leaf.id)) fail(`题目 id=${blockAttributes.id} 重复。`);
      seenIds.add(leaf.id);
      questions.push(leaf);
      continue;
    }

    const intro = blockBody.slice(0, partMatches[0].index).trim();
    let partPointSum = 0;
    for (const [partIndex, part] of partMatches.entries()) {
      const partName = part[1].trim();
      const partPoints = Number(part[2]);
      const partAttributes = parseAttributes(part[3]);
      const partBody = blockBody
        .slice(part.index + part[0].length, partMatches[partIndex + 1]?.index ?? blockBody.length)
        .trim();
      const label = `${number}(${partName})`;
      const leaf = buildLeaf({
        slug: metadata.slug,
        number,
        title,
        label,
        points: partPoints,
        body: partBody,
        intro,
        attributes: partAttributes,
        answers,
        sortOrder: questions.length,
      });
      if (seenIds.has(leaf.id)) fail(`题目 id=${partAttributes.id} 重复。`);
      seenIds.add(leaf.id);
      questions.push(leaf);
      partPointSum += partPoints;
    }
    if (Math.abs(partPointSum - parentPoints) > 0.0001) {
      fail(`Question ${number} 标注 ${parentPoints} 分，但各小问合计 ${partPointSum} 分。`);
    }
  }
  return questions;
}

function readEntry(entries, name, maximumBytes) {
  const entry = entries.get(name);
  if (!entry) fail(`ZIP 中缺少 ${name}。`);
  const data = entry.getData();
  if (data.length > maximumBytes) fail(`${name} 文件过大。`);
  return data.toString("utf8").replace(/^\uFEFF/, "");
}

function validateMetadata(rawMetadata) {
  const metadata = rawMetadata && typeof rawMetadata === "object" ? rawMetadata : {};
  if (metadata.formatVersion !== 1) fail("exercise.json 的 formatVersion 必须为 1。");
  const slug = String(metadata.slug ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    fail("slug 只能使用小写字母、数字和连字符，最长 64 个字符。");
  }
  const code = String(metadata.code ?? "").trim();
  const title = String(metadata.title ?? "").trim();
  const subtitle = String(metadata.subtitle ?? "").trim();
  if (!code || code.length > 20) fail("code 不能为空，最长 20 个字符。");
  if (!title || title.length > 120) fail("title 不能为空，最长 120 个字符。");
  if (!subtitle || subtitle.length > 240) fail("subtitle 不能为空，最长 240 个字符。");
  const expectedPoints = Number(metadata.expectedPoints);
  if (!Number.isFinite(expectedPoints) || expectedPoints <= 0 || expectedPoints > 1000) {
    fail("expectedPoints 必须是 0～1000 之间的正数。");
  }
  return {
    formatVersion: 1,
    slug,
    code,
    title,
    subtitle,
    expectedPoints,
    timeMinutes: Number.isFinite(Number(metadata.timeMinutes))
      ? Number(metadata.timeMinutes)
      : null,
    publishImmediately: metadata.publishImmediately === true,
  };
}

export function parseExercisePackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) fail("上传内容不是有效 ZIP。");
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    fail("无法读取 ZIP 文件。");
  }
  const zipEntries = zip.getEntries();
  if (zipEntries.length > 100) fail("ZIP 内文件数量不能超过 100。");

  const entries = new Map();
  let uncompressedBytes = 0;
  for (const entry of zipEntries) {
    const name = entry.entryName.replaceAll("\\", "/").replace(/^\.\/+/, "");
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("../") ||
      name.includes(":") ||
      name.includes("\0")
    ) {
      fail("ZIP 中包含不安全的文件路径。");
    }
    if (entry.isDirectory) continue;
    uncompressedBytes += entry.header.size;
    if (uncompressedBytes > 25 * 1024 * 1024) fail("ZIP 解压后总大小不能超过 25 MB。");
    entries.set(name, entry);
  }

  let rawMetadata;
  try {
    rawMetadata = JSON.parse(readEntry(entries, "exercise.json", 50 * 1024));
  } catch (error) {
    if (error.statusCode) throw error;
    fail("exercise.json 不是有效 JSON。");
  }
  const metadata = validateMetadata(rawMetadata);
  const questionSource = readEntry(entries, "questions.md", 2 * 1024 * 1024);
  const answerSource = readEntry(entries, "answers.md", 2 * 1024 * 1024);

  const assets = [];
  let assetBytes = 0;
  for (const [name, entry] of entries) {
    if (!name.startsWith("assets/")) continue;
    const relativeName = name.slice("assets/".length);
    const extension = path.extname(relativeName).toLowerCase();
    if (
      !relativeName ||
      relativeName.includes("..") ||
      !/^[A-Za-z0-9._/-]+$/.test(relativeName) ||
      !allowedAssetExtensions.has(extension)
    ) {
      fail(`不支持的素材文件：${name}`);
    }
    const data = entry.getData();
    assetBytes += data.length;
    if (assetBytes > 8 * 1024 * 1024) fail("素材文件总大小不能超过 8 MB。");
    assets.push({ name: relativeName, data });
  }

  const questions = parseQuestions(questionSource, answerSource, metadata);
  const totalPoints = questions.reduce((sum, question) => sum + question.maxPoints, 0);
  if (Math.abs(totalPoints - metadata.expectedPoints) > 0.0001) {
    fail(
      `题目总分为 ${totalPoints}，与 exercise.json 的 expectedPoints=${metadata.expectedPoints} 不一致。`,
    );
  }

  return {
    exercise: {
      slug: metadata.slug,
      code: metadata.code,
      title: metadata.title,
      subtitle: metadata.subtitle,
      page: `/practice.html?slug=${encodeURIComponent(metadata.slug)}`,
      totalPoints,
      questionCount: questions.length,
      visible: metadata.publishImmediately ? 1 : 0,
      questions,
    },
    metadata,
    assets,
  };
}
