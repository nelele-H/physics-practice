import {
  api,
  bindLogout,
  escapeHtml,
  formatNumber,
  getSession,
  initializeImagePreviews,
  setUserLabel,
  statusChip,
  toast,
} from "./common.js";

const slug =
  document.body.dataset.exercise || new URLSearchParams(window.location.search).get("slug");
const root = document.querySelector("#practice-root");
if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  root.innerHTML = '<div class="notice notice-error">练习地址无效。</div>';
  throw new Error("练习地址无效");
}
const user = await getSession("student");
if (!user) throw new Error("未登录");
setUserLabel(user);
bindLogout();
initializeImagePreviews();

let data;
let activeFilter = "all";

function answered(questionId) {
  return Boolean(data.responses[questionId]?.answer?.trim());
}

function renderResult(question) {
  const result = data.results[question.id];
  if (!result) return "";
  const full = result.score >= result.maxPoints;
  return `
    <div class="result-box ${full ? "result-correct" : "result-wrong"}">
      <div>
        <strong>${full ? "✓ 正确" : result.score > 0 ? "△ 部分正确" : "× 错误"}</strong>
        <span class="points">${formatNumber(result.score)} / ${formatNumber(result.maxPoints)} 分</span>
      </div>
      ${
        result.comment
          ? `<div><strong>教师评语</strong><p>${escapeHtml(result.comment)}</p></div>`
          : ""
      }
      ${
        result.answerHtml
          ? `<div class="answer-key"><strong>正确答案与解析</strong><div class="markdown">${result.answerHtml}</div></div>`
          : ""
      }
    </div>
  `;
}

function textResponseValues(question) {
  const response = data.responses[question.id]?.answer ?? "";
  try {
    const values = JSON.parse(response);
    if (Array.isArray(values)) return values.map((value) => String(value ?? ""));
  } catch {
    // 旧版文本答案不是 JSON 时，仅放入第一个空格，方便学生重新保存。
  }
  return response ? [response] : [];
}

function renderPrompt(question, locked) {
  if (question.input_mode !== "text") return question.prompt_html;
  const values = textResponseValues(question);
  let blankIndex = 0;
  return question.prompt_html.replaceAll("___", () => {
    const index = blankIndex++;
    return `<input
      class="inline-blank-input"
      data-text-answer
      data-blank-index="${index}"
      aria-label="第 ${index + 1} 个空"
      maxlength="200"
      autocomplete="off"
      ${locked ? "disabled" : ""}
      value="${escapeHtml(values[index] ?? "")}"
      placeholder="填写此空"
    />`;
  });
}

function renderInput(question, locked) {
  const response = data.responses[question.id]?.answer ?? "";
  if (question.input_mode === "mcq") {
    return `
      <div class="options" role="radiogroup" aria-label="选择答案">
        ${question.options
          .map(
            (option) => `
              <label class="option">
                <input
                  type="radio"
                  name="answer-${escapeHtml(question.id)}"
                  value="${option.key}"
                  ${response === option.key ? "checked" : ""}
                  ${locked ? "disabled" : ""}
                />
                <span><strong>${option.key}.</strong> ${option.html}</span>
              </label>
            `,
          )
          .join("")}
      </div>
    `;
  }
  if (question.input_mode === "numeric") {
    return `
      <div class="answer-area numeric-answer">
        <div class="numeric-rules">
          <span class="chip">单位：${escapeHtml(question.unit_label)}</span>
          <span class="chip">保留 ${question.required_decimals} 位小数</span>
        </div>
        <label class="field">
          <span class="helper">只填数值，不填单位。科学计数法示例：<code>1.1*10^2</code></span>
          <div class="numeric-input-row">
            <input
              class="input"
              data-answer
              inputmode="decimal"
              ${locked ? "disabled" : ""}
              value="${escapeHtml(response)}"
              placeholder="${question.required_decimals > 0 ? `保留 ${question.required_decimals} 位小数` : "填写整数"}"
            />
            <strong>${escapeHtml(question.unit_label)}</strong>
          </div>
        </label>
      </div>
    `;
  }
  if (question.input_mode === "text") {
    return `
      <div class="answer-area inline-blank-help">
        <span class="helper">每个输入框只填写对应空格中缺少的词或词组，不要重复整句。</span>
      </div>
    `;
  }
  return `
    <div class="answer-area">
      <label class="field">
        <span class="helper">填写你的答案、计算过程和单位</span>
        <textarea
          class="textarea"
          data-answer
          ${locked ? "disabled" : ""}
          placeholder="在这里写答案…"
        >${escapeHtml(response)}</textarea>
      </label>
    </div>
  `;
}

function questionMatchesFilter(question) {
  if (activeFilter === "answered") return answered(question.id);
  if (activeFilter === "unanswered") return !answered(question.id);
  if (activeFilter === "incorrect") {
    const result = data.results[question.id];
    return result && result.score < result.maxPoints;
  }
  return true;
}

function renderQuestions() {
  const locked = data.attempt.status !== "draft";
  const visible = data.questions.filter(questionMatchesFilter);
  const list = document.querySelector("#question-list");
  list.innerHTML = visible.length
    ? visible
        .map((question) => {
          const result = data.results[question.id];
          const incomplete = Boolean(result && Number(result.score) < Number(result.maxPoints));
          return `
            <article class="card question-card ${incomplete ? "question-card-incomplete" : ""}" id="${escapeHtml(question.id)}" data-question-id="${escapeHtml(question.id)}" data-type="${question.input_mode}">
              <div class="question-head">
                <div class="question-number">
                  <strong>第 ${escapeHtml(question.label)} 题</strong>
                  ${question.title ? `<span class="helper">${escapeHtml(question.title)}</span>` : ""}
                </div>
                <div class="question-score-summary">
                  ${incomplete ? '<span class="chip chip-error incomplete-score-badge">未满分</span>' : ""}
                  <span class="points">${formatNumber(question.max_points)} 分</span>
                </div>
              </div>
              <div class="question-body">
                <div class="markdown">${renderPrompt(question, locked)}</div>
                ${renderInput(question, locked)}
                ${
                  locked
                    ? ""
                    : `<div class="question-actions">
                        <span class="save-state" data-save-state>${answered(question.id) ? "已保存" : "尚未作答"}</span>
                        <div>
                          <button class="button button-danger button-small" data-delete>删除答案</button>
                          <button class="button button-primary button-small" data-save>保存答案</button>
                        </div>
                      </div>`
                }
                ${renderResult(question)}
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="card empty-state">这个筛选条件下暂时没有题目。</div>`;
  bindQuestionActions();
}

function currentAnswer(card) {
  if (card.dataset.type === "mcq") {
    return card.querySelector("input[type='radio']:checked")?.value ?? "";
  }
  if (card.dataset.type === "text") {
    return JSON.stringify(
      [...card.querySelectorAll("[data-text-answer]")].map((input) => input.value.trim()),
    );
  }
  return card.querySelector("[data-answer]")?.value ?? "";
}

function bindQuestionActions() {
  document.querySelectorAll("[data-question-id]").forEach((card) => {
    const questionId = card.dataset.questionId;
    card.querySelector("[data-save]")?.addEventListener("click", async () => {
      const answer = currentAnswer(card).trim();
      if (
        !answer ||
        (card.dataset.type === "text" &&
          JSON.parse(answer).some((entry) => !entry))
      ) {
        toast("请先填写或选择答案。", "error");
        return;
      }
      const button = card.querySelector("[data-save]");
      button.disabled = true;
      try {
        const payload = await api(`/api/exercises/${slug}/responses/${questionId}`, {
          method: "PUT",
          body: JSON.stringify({ answer }),
        });
        data.responses[questionId] = { answer, updatedAt: payload.updatedAt };
        card.querySelector("[data-save-state]").textContent = "刚刚保存";
        renderProgress();
        toast(`第 ${card.querySelector(".question-number strong").textContent.replace("第 ", "")}已保存`);
      } catch (error) {
        toast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });

    card.querySelector("[data-delete]")?.addEventListener("click", async () => {
      if (!answered(questionId) && !currentAnswer(card).trim()) return;
      const button = card.querySelector("[data-delete]");
      button.disabled = true;
      try {
        await api(`/api/exercises/${slug}/responses/${questionId}`, { method: "DELETE" });
        delete data.responses[questionId];
        card.querySelectorAll("input[type='radio']").forEach((input) => (input.checked = false));
        card.querySelectorAll("[data-text-answer]").forEach((input) => (input.value = ""));
        const textarea = card.querySelector("[data-answer]");
        if (textarea) textarea.value = "";
        card.querySelector("[data-save-state]").textContent = "答案已删除";
        renderProgress();
        toast("答案已删除");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderProgress() {
  const count = data.questions.filter((question) => answered(question.id)).length;
  const percent = data.questions.length ? (count / data.questions.length) * 100 : 0;
  document.querySelector("#answered-count").textContent = `${count} / ${data.questions.length}`;
  document.querySelector("#progress-bar").style.width = `${percent}%`;
}

function renderPage() {
  const status = data.attempt.status;
  root.innerHTML = `
    <div class="page-heading">
      <div>
        <p class="eyebrow">${escapeHtml(data.exercise.code)} · Practice</p>
        <h1>${escapeHtml(data.exercise.title)}</h1>
        <p>${escapeHtml(data.exercise.subtitle)}。可以只完成你想练习的题目。</p>
      </div>
      ${statusChip(status, data.attempt.statusLabel)}
    </div>
    ${
      status === "published"
        ? `<div class="notice notice-success" style="margin-bottom: 22px">
            <strong>成绩：${formatNumber(data.attempt.totalScore)} / ${formatNumber(data.attempt.maxScore)} 分</strong>
            ${
              data.attempt.overallComment
                ? `<div style="margin-top:8px">总体评语：${escapeHtml(data.attempt.overallComment)}</div>`
                : ""
            }
          </div>`
        : status === "grading"
          ? `<div class="notice" style="margin-bottom: 22px">教师已经开始批改，当前答案已锁定，暂时不能修改。</div>`
          : ""
    }
    <div class="practice-layout">
      <aside class="card practice-sidebar">
        <h3>题目导航</h3>
        <p class="helper">已保存 <strong id="answered-count">0</strong></p>
        <div class="progress" aria-label="作答进度"><span id="progress-bar"></span></div>
        <div class="filter-list" style="margin-top:16px">
          <button class="button button-soft filter-button active" data-filter="all">全部题目</button>
          <button class="button button-soft filter-button" data-filter="unanswered">未作答</button>
          <button class="button button-soft filter-button" data-filter="answered">已作答</button>
          ${
            status === "published"
              ? `<button class="button button-soft filter-button" data-filter="incorrect">错题与部分正确</button>`
              : ""
          }
        </div>
      </aside>
      <section id="question-list" class="question-list"></section>
    </div>
  `;

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderQuestions();
    });
  });
  renderProgress();
  renderQuestions();
}

try {
  data = await api(`/api/exercises/${slug}`);
  renderPage();
} catch (error) {
  root.innerHTML = `<div class="notice notice-error">${escapeHtml(error.message)}</div>`;
}
