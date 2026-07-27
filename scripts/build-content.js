import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import katex from "katex";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const sourceRoot = path.resolve(root, "..", "AL_PH");
const outputDir = path.join(root, "content");
const outputFile = path.join(outputDir, "exercises.json");

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
});

const sources = [
  {
    slug: "topic1a-motion",
    code: "1A",
    title: "Topic 1A · Motion 运动",
    subtitle: "速度、加速度、力、力矩与运动学",
    questionFile: "Topic1A_Motion_中英双语专项练习.md",
    answerFile: "Topic1A_Motion_中英双语专项练习_答案.md",
    page: "/practice/topic1a-motion.html",
  },
  {
    slug: "topic1b-energy",
    code: "1B",
    title: "Topic 1B · Energy 能量",
    subtitle: "功、能量、功率与效率",
    questionFile: "Topic1B_Energy_中英双语专项练习.md",
    answerFile: "Topic1B_Energy_中英双语专项练习_答案.md",
    page: "/practice/topic1b-energy.html",
  },
  {
    slug: "topic1c-momentum",
    code: "1C",
    title: "Topic 1C · Momentum 动量",
    subtitle: "冲量、碰撞、动量守恒与实验",
    questionFile: "Topic1C_Momentum_中英双语专项练习.md",
    answerFile: "Topic1C_Momentum_中英双语专项练习_答案.md",
    page: "/practice/topic1c-momentum.html",
  },
  {
    slug: "topic1-mechanics-test",
    code: "TEST",
    title: "Topic 1 · Mechanics 单元测试",
    subtitle: "运动、能量与动量综合测试",
    questionFile: "Topic1_Mechanics_中英双语单元测试.md",
    answerFile: "Topic1_Mechanics_中英双语单元测试_答案.md",
    page: "/practice/topic1-mechanics-test.html",
  },
];

function renderMarkdown(source) {
  const mathBlocks = [];
  const protectedSource = source.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_all, formula) => {
    const token = `MATHBLOCKTOKEN${mathBlocks.length}ENDTOKEN`;
    mathBlocks.push(
      katex.renderToString(formula.trim(), {
        displayMode: true,
        throwOnError: true,
        strict: "error",
      }),
    );
    return `\n\n${token}\n\n`;
  });

  let html = md.render(protectedSource);
  mathBlocks.forEach((mathHtml, index) => {
    html = html.replace(`<p>MATHBLOCKTOKEN${index}ENDTOKEN</p>`, mathHtml);
  });
  return html;
}

function renderInline(source) {
  return md.renderInline(source.trim());
}

function superscript(value) {
  return String(value).replaceAll("-", "⁻").replaceAll("0", "⁰").replaceAll("1", "¹").replaceAll("2", "²").replaceAll("3", "³").replaceAll("4", "⁴").replaceAll("5", "⁵").replaceAll("6", "⁶").replaceAll("7", "⁷").replaceAll("8", "⁸").replaceAll("9", "⁹");
}

function cleanUnit(rawUnit) {
  return String(rawUnit ?? "")
    .replace(/\^\{?\\circ\}?/g, "°")
    .replace(/\\%/g, "%")
    .replace(/\^\{([+-]?\d+)\}/g, (_all, power) => superscript(power))
    .replace(/\^([+-]?\d+)/g, (_all, power) => superscript(power))
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\mathrm\{([^}]*)\}/g, "$1")
    .replace(/\\(?:,|;|quad|qquad)/g, " ")
    .replace(/[{}$`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[=:,\s]+/, "")
    .replace(/[，。,；;].*$/, "")
    .trim();
}

function parseNumericToken(rawToken) {
  const normalized = String(rawToken)
    .trim()
    .replace(/\\times|×/g, "*")
    .replace(/\s+/g, "")
    .replace(/\^\{([+-]?\d+)\}/g, "^$1");
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\*10\^([+-]?\d+))?$/);
  if (!match) return null;
  const mantissa = match[1];
  const exponent = Number(match[2] ?? 0);
  const decimalPart = mantissa.replace(/^[+-]/, "").split(".")[1] ?? "";
  const value = Number(mantissa) * 10 ** exponent;
  if (!Number.isFinite(value)) return null;
  return {
    value,
    mantissa,
    exponent,
    decimals: decimalPart.length,
    display: match[2] === undefined ? mantissa : `${mantissa}*10^${exponent}`,
  };
}

function extractNumericSpec(answerMarkdown) {
  const explicitAnswer = answerMarkdown.match(
    /\*\*(?:答案\s*\/\s*Answer|答案|Answer):?\*\*\s*`([^`]+)`/i,
  );
  const candidates = [];

  if (explicitAnswer) {
    const match = explicitAnswer[1].match(
      /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*(?:\\times|×|\*)\s*10\s*\^\s*\{?[+-]?\d+\}?)?)\s*(.*)$/,
    );
    if (match) candidates.push({ token: match[1], unit: match[2], priority: 3 });
  }

  for (const mathBlock of answerMarkdown.matchAll(/\$\$\s*([\s\S]*?)\s*\$\$/g)) {
    for (const equality of mathBlock[1].matchAll(
      /=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*(?:\\times|×|\*)\s*10\s*\^\s*\{?[+-]?\d+\}?)?)(.*?)(?==|\n|$)/g,
    )) {
      candidates.push({ token: equality[1], unit: equality[2], priority: 2 });
    }
  }

  for (const inline of answerMarkdown.matchAll(
    /`([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*(?:×|\*)\s*10\s*\^\s*\{?[+-]?\d+\}?)?\s+[^`]+)`/g,
  )) {
    const match = inline[1].match(
      /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*(?:×|\*)\s*10\s*\^\s*\{?[+-]?\d+\}?)?)\s*(.*)$/,
    );
    if (match) candidates.push({ token: match[1], unit: match[2], priority: 1 });
  }

  candidates.sort((a, b) => a.priority - b.priority);
  const selected = candidates.at(-1);
  if (!selected) return null;
  const number = parseNumericToken(selected.token);
  if (!number) return null;
  const unit = cleanUnit(selected.unit);
  if (!unit || unit.length > 45) return null;
  const scale = 10 ** number.exponent;
  return {
    value: number.value,
    display: number.display,
    requiredDecimals: number.decimals,
    tolerance: 0.5000001 * 10 ** -number.decimals * scale,
    unit,
  };
}

function shouldUseNumericInput(promptMarkdown, answerMarkdown, maxPoints) {
  if (maxPoints > 4) return null;
  const prompt = promptMarkdown.replace(/`[^`]*`/g, " ").replace(/\s+/g, " ");
  const directCalculation =
    /(求|计算|算出|确定|是多少|为多少|calculate|determine|find|what is|how (?:far|long|fast|much))/i.test(
      prompt,
    );
  const subjective =
    /(解释|说明为什么|描述|评价|评估|建议|定义|比较|画出|作图|改进|误差|不确定度|方法|步骤|趋势|关系|state|define|explain|describe|suggest|evaluate|comment|compare|sketch|draw|plot|outline|discuss|improve|uncertainty|method|procedure|trend|relationship|why)/i.test(
      prompt,
    );
  const disclosed = /(证明|(?:^|\n)\s*show that)/i.test(promptMarkdown);
  const directionRequired =
    /(大小和方向|数值和方向|写出方向|指出方向|magnitude and direction|state (?:its |the )?direction|give (?:its |the )?direction)/i.test(
      prompt,
    );
  if (!directCalculation || subjective || disclosed || directionRequired) return null;
  const numeric = extractNumericSpec(answerMarkdown);
  if (!numeric) return null;
  return numeric;
}

function readSource(filename) {
  const fullPath = path.join(sourceRoot, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`找不到源文件：${fullPath}`);
  }
  return fs.readFileSync(fullPath, "utf8");
}

function splitQuestionBlocks(source) {
  const matches = [...source.matchAll(/^### Question\s+(\d+)(.*?)\[(\d+)\]\s*$/gm)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    title: match[2].trim(),
    points: Number(match[3]),
    body: source.slice(match.index + match[0].length, matches[index + 1]?.index ?? source.length).trim(),
  }));
}

function parseMcqAnswers(answerSource) {
  const result = new Map();
  for (const match of answerSource.matchAll(/^\|\s*(\d+)\s*\|\s*([A-D])\s*\|\s*(.*?)\s*\|\s*$/gm)) {
    result.set(Number(match[1]), {
      value: match[2],
      reason: match[3],
    });
  }
  return result;
}

function parseStructuredAnswers(answerSource) {
  const result = new Map();
  const blocks = splitQuestionBlocks(answerSource);

  for (const block of blocks) {
    const partMatches = [...block.body.matchAll(/^####\s+\(([^)]+)\)\s+\[(\d+)\]\s*$/gm)];
    if (!partMatches.length) {
      result.set(`${block.number}`, block.body.trim());
      continue;
    }
    partMatches.forEach((part, index) => {
      const body = block.body
        .slice(part.index + part[0].length, partMatches[index + 1]?.index ?? block.body.length)
        .trim();
      result.set(`${block.number}${part[1]}`, body);
    });
  }
  return result;
}

function parseOptions(body) {
  const matches = [...body.matchAll(/^([A-D])\.\s+/gm)];
  if (matches.length !== 4) {
    const tableMatches = [...body.matchAll(/^\|\s*([A-D])\s*\|.*\|\s*$/gm)];
    if (tableMatches.length === 4) {
      return {
        prompt: body,
        options: tableMatches.map((match) => ({
          key: match[1],
          html: renderInline(`选择 ${match[1]} / Choose ${match[1]}`),
        })),
      };
    }
    return null;
  }

  const prompt = body.slice(0, matches[0].index).trim();
  const options = matches.map((match, index) => ({
    key: match[1],
    html: renderMarkdown(
      body.slice(match.index + match[0].length, matches[index + 1]?.index ?? body.length).trim(),
    ),
  }));
  return { prompt, options };
}

function buildExercise(spec) {
  const questionSource = readSource(spec.questionFile);
  const answerSource = readSource(spec.answerFile);
  const questionBlocks = splitQuestionBlocks(questionSource);
  const mcqAnswers = parseMcqAnswers(answerSource);
  const structuredAnswers = parseStructuredAnswers(answerSource);
  const questions = [];
  let sortOrder = 0;

  for (const block of questionBlocks) {
    const optionData = mcqAnswers.has(block.number) ? parseOptions(block.body) : null;
    if (optionData) {
      const key = `${block.number}`;
      const answer = mcqAnswers.get(block.number);
      questions.push({
        id: `${spec.slug}-q${key}`,
        label: `${block.number}`,
        parentNumber: block.number,
        title: block.title,
        type: "mcq",
        inputMode: "mcq",
        maxPoints: block.points,
        promptHtml: renderMarkdown(optionData.prompt),
        options: optionData.options,
        correctValue: answer.value,
        numericValue: null,
        numericTolerance: null,
        requiredDecimals: null,
        unitLabel: null,
        answerHtml: renderMarkdown(`**正确选项：${answer.value}**\n\n${answer.reason}`),
        sortOrder: sortOrder++,
      });
      continue;
    }

    const partMatches = [...block.body.matchAll(/^####\s+\(([^)]+)\)\s+\[(\d+)\]\s*$/gm)];
    if (!partMatches.length) {
      const key = `${block.number}`;
      const answerMd = structuredAnswers.get(key);
      const numeric = shouldUseNumericInput(block.body, answerMd ?? "", block.points);
      questions.push({
        id: `${spec.slug}-q${key}`,
        label: `${block.number}`,
        parentNumber: block.number,
        title: block.title,
        type: "manual",
        inputMode: numeric ? "numeric" : "manual",
        maxPoints: block.points,
        promptHtml: renderMarkdown(block.body),
        options: [],
        correctValue: numeric?.display ?? null,
        numericValue: numeric?.value ?? null,
        numericTolerance: numeric?.tolerance ?? null,
        requiredDecimals: numeric?.requiredDecimals ?? null,
        unitLabel: numeric?.unit ?? null,
        answerHtml: renderMarkdown(answerMd ?? "暂无标准答案。"),
        sortOrder: sortOrder++,
      });
      continue;
    }

    const intro = block.body.slice(0, partMatches[0].index).trim();
    partMatches.forEach((part, index) => {
      const partName = part[1];
      const partPoints = Number(part[2]);
      const partBody = block.body
        .slice(part.index + part[0].length, partMatches[index + 1]?.index ?? block.body.length)
        .trim();
      const key = `${block.number}${partName}`;
      const answerMd = structuredAnswers.get(key);
      const promptMd = [intro, partBody].filter(Boolean).join("\n\n---\n\n");
      const numeric = shouldUseNumericInput(promptMd, answerMd ?? "", partPoints);
      questions.push({
        id: `${spec.slug}-q${key}`,
        label: `${block.number}(${partName})`,
        parentNumber: block.number,
        title: block.title,
        type: "manual",
        inputMode: numeric ? "numeric" : "manual",
        maxPoints: partPoints,
        promptHtml: renderMarkdown(promptMd),
        options: [],
        correctValue: numeric?.display ?? null,
        numericValue: numeric?.value ?? null,
        numericTolerance: numeric?.tolerance ?? null,
        requiredDecimals: numeric?.requiredDecimals ?? null,
        unitLabel: numeric?.unit ?? null,
        answerHtml: renderMarkdown(answerMd ?? "暂无标准答案。"),
        sortOrder: sortOrder++,
      });
    });
  }

  const missingAnswers = questions.filter((question) => question.answerHtml.includes("暂无标准答案"));
  if (missingAnswers.length) {
    throw new Error(
      `${spec.slug} 有 ${missingAnswers.length} 个小题缺少答案：${missingAnswers
        .map((question) => question.label)
        .join(", ")}`,
    );
  }

  return {
    ...spec,
    totalPoints: questions.reduce((sum, question) => sum + question.maxPoints, 0),
    questionCount: questions.length,
    questions,
  };
}

fs.mkdirSync(outputDir, { recursive: true });
const exercises = sources.map(buildExercise);
fs.writeFileSync(outputFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), exercises }, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      output: outputFile,
      exercises: exercises.map((exercise) => ({
        slug: exercise.slug,
        questions: exercise.questionCount,
        points: exercise.totalPoints,
        modes: Object.fromEntries(
          ["mcq", "numeric", "manual"].map((mode) => [
            mode,
            exercise.questions.filter((question) => question.inputMode === mode).length,
          ]),
        ),
      })),
    },
    null,
    2,
  ),
);
