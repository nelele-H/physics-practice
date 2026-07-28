import {
  api,
  bindLogout,
  escapeHtml,
  formatNumber,
  formatPercent,
  getSession,
  setUserLabel,
  statusChip,
  toast,
} from "./common.js";

const user = await getSession("teacher");
if (!user) throw new Error("未登录");
setUserLabel(user);
bindLogout();

let exercises = [];
let users = [];
let attempts = [];
let currentReview = null;
let managedExercises = [];
let teacherExerciseQuery = "";
let managedExercisePage = 1;
const EXERCISES_PER_PAGE = 6;

function activateTeacherTab(tabName) {
  document.querySelectorAll("[data-tab]").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  document.querySelector(`#tab-${tabName}`).classList.remove("hidden");
}

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => activateTeacherTab(button.dataset.tab));
});

function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .trim();
}

function formatStudentAnswer(item) {
  if (!item.answered) return '<span class="unanswered-label">未作答</span>';
  if (item.input_mode !== "text") return escapeHtml(item.answer_text);
  try {
    const values = JSON.parse(item.answer_text);
    if (Array.isArray(values)) {
      return values
        .map((value, index) => `<strong>空 ${index + 1}：</strong>${escapeHtml(value)}`)
        .join("<br />");
    }
  } catch {
    // 兼容旧版未使用 JSON 保存的文本答案。
  }
  return escapeHtml(item.answer_text);
}

function matchesExercise(exercise, query) {
  if (!query) return true;
  return normalizeSearch(
    [exercise.code, exercise.title, exercise.subtitle, exercise.slug].join(" "),
  ).includes(query);
}

function renderTeacherExerciseSearch() {
  const resultsPanel = document.querySelector("#teacher-exercise-search-results");
  const count = document.querySelector("#teacher-exercise-search-count");
  const matches = managedExercises.filter((exercise) =>
    matchesExercise(exercise, teacherExerciseQuery),
  );

  count.textContent = teacherExerciseQuery
    ? `找到 ${matches.length} 套，共 ${managedExercises.length} 套`
    : `共 ${managedExercises.length} 套练习`;

  if (!teacherExerciseQuery) {
    resultsPanel.classList.add("hidden");
    resultsPanel.replaceChildren();
    return;
  }

  resultsPanel.classList.remove("hidden");
  resultsPanel.innerHTML = matches.length
    ? matches
        .map(
          (exercise) => `
            <article class="search-result-item">
              <div>
                <div class="search-result-title">
                  <strong>${escapeHtml(exercise.code)} · ${escapeHtml(exercise.title)}</strong>
                  ${
                    exercise.visible
                      ? '<span class="chip chip-success">已发布</span>'
                      : '<span class="chip">草稿 / 已下架</span>'
                  }
                </div>
                <p>${escapeHtml(exercise.subtitle || exercise.slug)}</p>
              </div>
              <div class="table-actions">
                ${
                  exercise.visible
                    ? `
                        <button class="button button-soft button-small" data-search-action="submissions" data-id="${exercise.id}">查看作答</button>
                        <button class="button button-soft button-small" data-search-action="stats" data-id="${exercise.id}">查看统计</button>
                      `
                    : ""
                }
                <button class="button button-primary button-small" data-search-action="exercises" data-id="${exercise.id}">题库管理</button>
              </div>
            </article>
          `,
        )
        .join("")
    : `
        <div class="empty-search">
          <strong>没有找到相关练习</strong>
          <p>可以换用练习编号、标题中的短关键词或 slug。</p>
        </div>
      `;

  resultsPanel.querySelectorAll("[data-search-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const exercise = managedExercises.find((item) => item.id === Number(button.dataset.id));
      if (!exercise) return;
      const action = button.dataset.searchAction;
      activateTeacherTab(action);
      if (action === "submissions") await loadAttempts(exercise.id);
      if (action === "stats") await loadStats(exercise.id);
      if (action === "exercises") {
        const exerciseIndex = managedExercises.findIndex((item) => item.id === exercise.id);
        managedExercisePage = Math.floor(exerciseIndex / EXERCISES_PER_PAGE) + 1;
        renderExerciseManagement();
        const row = document.querySelector(`[data-managed-exercise="${exercise.id}"]`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        row?.classList.add("search-hit");
        setTimeout(() => row?.classList.remove("search-hit"), 1800);
      }
    });
  });
}

document.querySelector("#teacher-exercise-search").addEventListener("input", (event) => {
  teacherExerciseQuery = normalizeSearch(event.currentTarget.value);
  renderTeacherExerciseSearch();
});

function exerciseOptions(selectedId) {
  return exercises
    .map(
      (exercise) =>
        `<option value="${exercise.id}" ${Number(selectedId) === exercise.id ? "selected" : ""}>${escapeHtml(exercise.title)}</option>`,
    )
    .join("");
}

async function loadUsers() {
  ({ users } = await api("/api/teacher/users"));
  renderStudents();
}

function renderStudents() {
  const panel = document.querySelector("#tab-students");
  panel.innerHTML = `
    <div class="split-grid">
      <article class="card card-pad">
        <div class="section-heading">
          <div><h2>生成学生激活码</h2><p>学生用激活码自定义用户名和密码。</p></div>
        </div>
        <form id="token-form" class="form-grid">
          <div class="field">
            <label for="token-note">教师备注（可选）</label>
            <input class="input" id="token-note" placeholder="例如：小明，只有教师能看到" />
          </div>
          <button class="button button-primary" type="submit">生成一次性激活码</button>
        </form>
        <div id="token-result" class="notice hidden" style="margin-top:14px"></div>
      </article>
      <article class="card card-pad">
        <div class="section-heading">
          <div><h2>直接创建账号</h2><p>教师输入学生选好的用户名和临时密码。</p></div>
        </div>
        <form id="create-user-form" class="form-grid">
          <div class="field"><label>用户名</label><input class="input" name="username" required /></div>
          <div class="field"><label>临时密码</label><input class="input" name="password" type="password" minlength="6" required /></div>
          <div class="field"><label>教师备注</label><input class="input" name="note" /></div>
          <button class="button button-primary" type="submit">创建学生账号</button>
        </form>
      </article>
    </div>
    <article class="card card-pad">
      <div class="section-heading">
        <div><h2>学生账号</h2><p>可以维护账号；永久删除会同时清除该学生的全部作答和评分记录。</p></div>
        <span class="chip">${users.length} 个账号</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>用户名</th><th>教师备注</th><th>状态</th><th>作答数据</th><th>操作</th></tr></thead>
          <tbody>
            ${
              users.length
                ? users
                    .map(
                      (student) => `
                        <tr>
                          <td><strong>${escapeHtml(student.username)}</strong></td>
                          <td>${escapeHtml(student.note || "—")}</td>
                          <td>${student.active ? '<span class="chip chip-success">可登录</span>' : '<span class="chip chip-error">已停用</span>'}</td>
                          <td>
                            ${student.attempt_count} 套练习<br />
                            <span class="helper">${student.response_count} 份答案，${student.grading_count} 项评分</span>
                          </td>
                          <td>
                            <div class="table-actions">
                              <button class="button button-plain button-small" data-user-action="rename" data-id="${student.id}">改用户名</button>
                              <button class="button button-plain button-small" data-user-action="reset" data-id="${student.id}">重置密码</button>
                              <button class="button button-plain button-small" data-user-action="logout" data-id="${student.id}">强制退出</button>
                              <button class="button ${student.active ? "button-danger" : "button-soft"} button-small" data-user-action="toggle" data-id="${student.id}">
                                ${student.active ? "停用" : "启用"}
                              </button>
                              <button class="button button-danger button-small" data-user-action="delete" data-id="${student.id}">
                                永久删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      `,
                    )
                    .join("")
                : '<tr><td colspan="5" class="empty-state">还没有学生账号。</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </article>
  `;
  bindStudentActions();
}

function bindStudentActions() {
  document.querySelector("#token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = await api("/api/teacher/activation-tokens", {
        method: "POST",
        body: JSON.stringify({ note: document.querySelector("#token-note").value }),
      });
      const result = document.querySelector("#token-result");
      result.className = "notice notice-success";
      result.innerHTML = `<strong style="font-size:22px;letter-spacing:.08em">${escapeHtml(payload.token)}</strong><br><span class="helper">7 天内有效，只能使用一次。</span>`;
    } catch (error) {
      toast(error.message, "error");
    }
  });

  document.querySelector("#create-user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api("/api/teacher/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.username.value,
          password: form.password.value,
          note: form.note.value,
        }),
      });
      form.reset();
      toast("学生账号已创建。");
      await loadUsers();
    } catch (error) {
      toast(error.message, "error");
    }
  });

  document.querySelectorAll("[data-user-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const student = users.find((item) => item.id === Number(button.dataset.id));
      if (!student) return;
      try {
        if (button.dataset.userAction === "rename") {
          const username = window.prompt("输入新的用户名：", student.username);
          if (!username) return;
          const note = window.prompt("教师备注：", student.note || "") ?? student.note;
          await api(`/api/teacher/users/${student.id}`, {
            method: "PATCH",
            body: JSON.stringify({ username, note }),
          });
          toast("用户名已更新。");
        }
        if (button.dataset.userAction === "reset") {
          const password = window.prompt("输入至少 6 位临时密码：");
          if (!password) return;
          await api(`/api/teacher/users/${student.id}/reset-password`, {
            method: "POST",
            body: JSON.stringify({ password }),
          });
          toast("密码已重置，学生现有登录已退出。");
        }
        if (button.dataset.userAction === "logout") {
          await api(`/api/teacher/users/${student.id}/logout`, {
            method: "POST",
            body: "{}",
          });
          toast("该学生已强制退出。");
        }
        if (button.dataset.userAction === "toggle") {
          await api(`/api/teacher/users/${student.id}`, {
            method: "PATCH",
            body: JSON.stringify({ active: !student.active }),
          });
          toast(student.active ? "账号已停用。" : "账号已启用。");
        }
        if (button.dataset.userAction === "delete") {
          const warning =
            `将永久删除学生账号“${student.username}”。\n\n` +
            `同时删除：${student.attempt_count} 套练习记录、${student.response_count} 份答案、` +
            `${student.grading_count} 项评分和全部评语。\n\n` +
            "删除前系统会自动备份数据库。是否继续？";
          if (!window.confirm(warning)) return;
          const confirmation = window.prompt(
            `请输入学生用户名以确认永久删除：\n${student.username}`,
          );
          if (confirmation !== student.username) {
            toast("确认文字不一致，已取消删除。", "error");
            return;
          }
          const result = await api(`/api/teacher/users/${student.id}`, {
            method: "DELETE",
            body: JSON.stringify({ confirmation }),
          });
          toast(`学生账号及全部作答数据已删除；删除前备份：${result.backup}`);
          await loadUsers();
          await refreshExerciseViews();
          return;
        }
        await loadUsers();
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });
}

async function loadAttempts(exerciseId) {
  ({ attempts } = await api(`/api/teacher/attempts?exerciseId=${exerciseId}`));
  renderSubmissions(exerciseId);
}

function renderSubmissions(selectedExerciseId = exercises[0]?.id) {
  const panel = document.querySelector("#tab-submissions");
  panel.innerHTML = `
    <article class="card card-pad">
      <div class="section-heading">
        <div><h2>学生作答</h2><p>先锁定答案，再进行批改。可以勾选多个学生批量锁定。</p></div>
      </div>
      <div class="toolbar">
        <div class="field">
          <label for="attempt-exercise">选择练习</label>
          <select class="select" id="attempt-exercise">${exerciseOptions(selectedExerciseId)}</select>
        </div>
        <button class="button button-primary" id="lock-selected">批量开始批改</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th><input type="checkbox" id="check-all" /></th><th>学生</th><th>已作答</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
            ${
              attempts.length
                ? attempts
                    .map(
                      (attempt) => `
                        <tr>
                          <td><input type="checkbox" data-attempt-check value="${attempt.id}" ${attempt.status !== "draft" || Number(attempt.answered_count) === 0 ? "disabled" : ""} /></td>
                          <td><strong>${escapeHtml(attempt.username)}</strong><br><span class="helper">${escapeHtml(attempt.note || "")}</span></td>
                          <td>${attempt.answered_count} 题 · ${formatNumber(attempt.answered_points)} 分</td>
                          <td>${statusChip(attempt.status, attempt.statusLabel)}</td>
                          <td>${new Date(attempt.updated_at).toLocaleString()}</td>
                          <td><div class="table-actions">
                            <button class="button button-primary button-small" data-review="${attempt.id}">${
                              attempt.status === "draft" && Number(attempt.answered_count) === 0
                                ? "打开查看"
                                : attempt.status === "draft"
                                  ? "锁定并批改"
                                  : "打开批改"
                            }</button>
                            ${attempt.status !== "draft" ? `<button class="button button-danger button-small" data-reopen="${attempt.id}">重新开放</button>` : ""}
                          </div></td>
                        </tr>
                      `,
                    )
                    .join("")
                : '<tr><td colspan="6" class="empty-state">这套练习还没有学生打开。</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </article>
    <div id="review-panel"></div>
  `;
  bindSubmissionActions();
}

function bindSubmissionActions() {
  const select = document.querySelector("#attempt-exercise");
  select.addEventListener("change", () => loadAttempts(Number(select.value)));
  document.querySelector("#check-all")?.addEventListener("change", (event) => {
    document
      .querySelectorAll("[data-attempt-check]:not(:disabled)")
      .forEach((checkbox) => (checkbox.checked = event.currentTarget.checked));
  });
  document.querySelector("#lock-selected")?.addEventListener("click", async () => {
    const ids = [...document.querySelectorAll("[data-attempt-check]:checked")].map((item) =>
      Number(item.value),
    );
    try {
      const payload = await api("/api/teacher/attempts/lock", {
        method: "POST",
        body: JSON.stringify({ attemptIds: ids }),
      });
      const locked = payload.results.filter((result) => result.ok).length;
      const skipped = payload.results.length - locked;
      toast(`已锁定 ${locked} 位学生${skipped ? `，跳过 ${skipped} 位` : ""}。`);
      await loadAttempts(Number(select.value));
    } catch (error) {
      toast(error.message, "error");
    }
  });
  document.querySelectorAll("[data-review]").forEach((button) => {
    button.addEventListener("click", () => openReview(Number(button.dataset.review)));
  });
  document.querySelectorAll("[data-reopen]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("重新开放后，现有评分会被清除，学生可以继续修改。确定吗？")) return;
      try {
        await api(`/api/teacher/attempts/${button.dataset.reopen}/reopen`, {
          method: "POST",
          body: "{}",
        });
        toast("已重新开放作答。");
        await loadAttempts(Number(select.value));
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });
}

async function openReview(attemptId) {
  let attempt = attempts.find((item) => item.id === attemptId);
  if (attempt?.status === "draft" && Number(attempt.answered_count) > 0) {
    const lock = await api("/api/teacher/attempts/lock", {
      method: "POST",
      body: JSON.stringify({ attemptIds: [attemptId] }),
    });
    if (!lock.results[0]?.ok) {
      toast(lock.results[0]?.message || "无法锁定该作答。", "error");
      return;
    }
  }
  currentReview = await api(`/api/teacher/attempts/${attemptId}`);
  renderReview();
}

function renderReview() {
  const panel = document.querySelector("#review-panel");
  const { attempt, items } = currentReview;
  const editable = attempt.status === "grading";
  panel.innerHTML = `
    <article class="card card-pad" style="margin-top:20px">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Review</p>
          <h2>${escapeHtml(attempt.username)} · ${escapeHtml(attempt.exercise_title)}</h2>
          <p>${statusChip(attempt.status, attempt.statusLabel)}</p>
        </div>
        <button class="button button-plain" id="close-review">关闭</button>
      </div>
      <div class="review-list">
        ${items
          .map(
            (item) => `
              <section class="review-item" ${item.answered ? `data-grade-item="${escapeHtml(item.question_id)}"` : ""}>
                <div>
                  <div class="question-number"><strong>第 ${escapeHtml(item.label)} 题</strong><span class="points">${formatNumber(item.max_points)} 分</span></div>
                  <div class="markdown">${item.prompt_html}</div>
                  <div class="student-answer"><strong>学生答案</strong><p>${formatStudentAnswer(item)}</p></div>
                  <div class="official-answer"><strong>参考答案与评分要点</strong><div class="markdown">${item.answer_html}</div></div>
                </div>
                ${
                  item.answered
                    ? `
                      <div class="review-controls">
                        <div class="field">
                          <label>得分（满分 ${formatNumber(item.max_points)}）</label>
                          <div class="score-row">
                            <input class="input" data-score type="number" min="0" max="${item.max_points}" step="0.5" value="${item.score ?? ""}" ${editable ? "" : "disabled"} />
                            <span>分</span>
                          </div>
                        </div>
                        <div class="field">
                          <label>逐题评语</label>
                          <textarea class="textarea" data-comment placeholder="指出做得好的地方或需要改进的地方" ${editable ? "" : "disabled"}>${escapeHtml(item.comment || "")}</textarea>
                        </div>
                        <span class="helper">${
                          item.input_mode === "mcq"
                            ? "选择题已由系统自动给分；如答案设置有误，教师可人工修改。"
                            : item.input_mode === "numeric"
                              ? `数值填空已由系统自动给分，教师可人工修改。指定单位 ${escapeHtml(item.unit_label)}，保留 ${item.required_decimals} 位小数。`
                              : item.input_mode === "text"
                                ? "文本填空已由系统逐空自动给分；如参考答案不完整，教师可人工修改。"
                                : "问答解释题由教师给分。"
                        }</span>
                      </div>
                    `
                    : `
                      <div class="review-controls unanswered-review">
                        <span class="chip">未作答</span>
                        <p>本题不计入本次作答得分，参考答案仍保留，方便课堂讲解。</p>
                      </div>
                    `
                }
              </section>
            `,
          )
          .join("")}
      </div>
      <div class="field" style="margin-top:22px">
        <label for="overall-comment">整套练习总体评语</label>
        <textarea class="textarea" id="overall-comment" placeholder="总结本次作答表现和下一步建议" ${editable ? "" : "disabled"}>${escapeHtml(attempt.overall_comment || "")}</textarea>
      </div>
      ${
        editable
          ? `<div class="question-actions">
              <span class="helper">发布前必须给所有已作答题目评分。</span>
              <div>
                <button class="button button-soft" id="save-grading">保存批改</button>
                <button class="button button-primary" id="publish-grading">保存并发布成绩</button>
              </div>
            </div>`
          : attempt.status === "draft"
            ? `<div class="notice" style="margin-top:18px">学生尚未作答，当前页面仅用于查看题目、参考答案和评分说明。</div>`
            : `<div class="notice notice-success" style="margin-top:18px">成绩已经发布。如需修改，请先在作答列表中点击“重新开放”。</div>`
      }
    </article>
  `;
  document.querySelector("#close-review").addEventListener("click", () => (panel.innerHTML = ""));
  document.querySelector("#save-grading")?.addEventListener("click", () => saveReview(false));
  document.querySelector("#publish-grading")?.addEventListener("click", () => saveReview(true));
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveReview(publish) {
  const grades = [...document.querySelectorAll("[data-grade-item]")]
    .map((item) => ({
      questionId: item.dataset.gradeItem,
      score: item.querySelector("[data-score]").value,
      comment: item.querySelector("[data-comment]").value,
    }))
    .filter((grade) => grade.score !== "");
  try {
    await api(`/api/teacher/attempts/${currentReview.attempt.id}/grading`, {
      method: "PUT",
      body: JSON.stringify({
        grades,
        overallComment: document.querySelector("#overall-comment").value,
      }),
    });
    if (publish) {
      const result = await api(`/api/teacher/attempts/${currentReview.attempt.id}/publish`, {
        method: "POST",
        body: "{}",
      });
      toast(`成绩已发布：${formatNumber(result.totalScore)} / ${formatNumber(result.maxScore)} 分`);
      currentReview = await api(`/api/teacher/attempts/${currentReview.attempt.id}`);
      renderReview();
      await loadAttempts(currentReview.attempt.exercise_id);
    } else {
      toast("批改已保存。");
      currentReview = await api(`/api/teacher/attempts/${currentReview.attempt.id}`);
      renderReview();
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadStats(exerciseId) {
  const { stats } = await api(`/api/teacher/stats/${exerciseId}`);
  renderStats(exerciseId, stats);
}

function renderStats(selectedExerciseId = exercises[0]?.id, stats = []) {
  const panel = document.querySelector("#tab-stats");
  panel.innerHTML = `
    <article class="card card-pad">
      <div class="section-heading">
        <div><h2>逐题正确率</h2><p>空白答案不计入作答人数；正确率只按已经评分的学生计算。</p></div>
      </div>
      <div class="toolbar">
        <div class="field">
          <label for="stats-exercise">选择练习</label>
          <select class="select" id="stats-exercise">${exerciseOptions(selectedExerciseId)}</select>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>题号</th><th>满分</th><th>作答人数</th><th>已评分</th><th>完全正确</th><th>正确率</th><th>平均得分率</th></tr></thead>
          <tbody>
            ${stats
              .map(
                (row) => `
                  <tr>
                    <td><strong>${escapeHtml(row.label)}</strong></td>
                    <td>${formatNumber(row.max_points)}</td>
                    <td>${row.answered_count}</td>
                    <td>${row.graded_count}</td>
                    <td>${row.full_correct_count}</td>
                    <td>${formatPercent(row.correctRate)}</td>
                    <td>${formatPercent(row.averageScoreRate)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </article>
  `;
  document
    .querySelector("#stats-exercise")
    .addEventListener("change", (event) => loadStats(Number(event.target.value)));
}

async function loadExerciseManagement() {
  ({ exercises: managedExercises } = await api("/api/teacher/exercise-management"));
  renderExerciseManagement();
  renderTeacherExerciseSearch();
}

function compactPageItems(currentPage, totalPages) {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (currentPage <= 3) return [1, 2, 3, 4, "ellipsis", totalPages];
  if (currentPage >= totalPages - 2) {
    return [1, "ellipsis", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}

function paginationMarkup(currentPage, totalPages) {
  if (totalPages <= 1) return "";
  const pageButtons = compactPageItems(currentPage, totalPages)
    .map(
      (page) =>
        page === "ellipsis"
          ? '<span class="pagination-ellipsis" aria-hidden="true">…</span>'
          : `
            <button
              class="button button-small ${page === currentPage ? "button-primary" : "button-soft"}"
              type="button"
              data-managed-page="${page}"
              aria-label="第 ${page} 页"
              ${page === currentPage ? 'aria-current="page"' : ""}
            >${page}</button>
          `,
    )
    .join("");
  const pageOptions = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map(
      (page) =>
        `<option value="${page}" ${page === currentPage ? "selected" : ""}>第 ${page} 页</option>`,
    )
    .join("");

  return `
    <button
      class="button button-soft button-small"
      type="button"
      data-managed-page="${currentPage - 1}"
      ${currentPage === 1 ? "disabled" : ""}
    >上一页</button>
    <div class="pagination-pages">${pageButtons}</div>
    <button
      class="button button-soft button-small"
      type="button"
      data-managed-page="${currentPage + 1}"
      ${currentPage === totalPages ? "disabled" : ""}
    >下一页</button>
    <label class="pagination-jump">
      <span>跳至</span>
      <select class="select pagination-select" data-managed-page-select aria-label="选择页码">
        ${pageOptions}
      </select>
    </label>
    <span class="pagination-status">第 ${currentPage} / ${totalPages} 页</span>
  `;
}

function renderExerciseManagement() {
  const totalPages = Math.max(1, Math.ceil(managedExercises.length / EXERCISES_PER_PAGE));
  managedExercisePage = Math.min(Math.max(managedExercisePage, 1), totalPages);
  const pageExercises = managedExercises.slice(
    (managedExercisePage - 1) * EXERCISES_PER_PAGE,
    managedExercisePage * EXERCISES_PER_PAGE,
  );
  const panel = document.querySelector("#tab-exercises");
  panel.innerHTML = `
    <div class="split-grid">
      <article class="card card-pad">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Import</p>
            <h2>新增练习</h2>
            <p>上传一个符合规范的 ZIP。系统会先检查题型、答案、总分、单位、小数位数和公式。</p>
          </div>
        </div>
        <form id="exercise-upload-form" class="form-grid">
          <div class="field">
            <label for="exercise-package">练习 ZIP</label>
            <input
              class="input"
              id="exercise-package"
              name="package"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              required
            />
            <span class="helper">最大 10 MB；包含 exercise.json、questions.md、answers.md，可选 assets 文件夹。</span>
          </div>
          <div class="table-actions">
            <button class="button button-primary" type="submit">检查并导入</button>
            <a class="button button-soft" href="/downloads/exercise-package-template.zip" download>下载格式模板</a>
          </div>
        </form>
        <div id="exercise-upload-result" class="notice hidden" style="margin-top:14px"></div>
      </article>
      <article class="card card-pad">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Safety</p>
            <h2>发布与删除规则</h2>
          </div>
        </div>
        <div class="notice">
          <p><strong>下架</strong>只对学生隐藏，历史作答仍保留。</p>
          <p><strong>永久删除</strong>会先自动备份，再删除题目、作答、评分、评语和统计；学生账号不受影响。</p>
          <p class="helper">永久删除后，内置练习也不会因服务重启而自动恢复。</p>
        </div>
      </article>
    </div>
    <article class="card card-pad">
      <div class="section-heading">
        <div><h2>练习题库</h2><p>上传包默认可保存为草稿，再由教师发布。</p></div>
        <span class="chip">${managedExercises.length} 套练习</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>练习</th><th>来源</th><th>状态</th><th>题量 / 总分</th>
              <th>作答数据</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${
              managedExercises.length
                ? pageExercises
                    .map(
                      (exercise) => `
                        <tr data-managed-exercise="${exercise.id}">
                          <td>
                            <strong>${escapeHtml(exercise.code)} · ${escapeHtml(exercise.title)}</strong>
                            <div class="helper">${escapeHtml(exercise.slug)}</div>
                          </td>
                          <td>${exercise.source_type === "uploaded" ? "上传" : "内置"}</td>
                          <td>${exercise.visible ? '<span class="chip chip-success">已发布</span>' : '<span class="chip">草稿 / 已下架</span>'}</td>
                          <td>${exercise.question_count} 题 / ${formatNumber(exercise.total_points)} 分</td>
                          <td>
                            ${exercise.attempt_count} 位学生<br />
                            <span class="helper">${exercise.response_count} 份答案，${exercise.grading_count} 项评分</span>
                          </td>
                          <td>
                            <div class="table-actions">
                              <button
                                class="button button-soft button-small"
                                data-exercise-action="visibility"
                                data-id="${exercise.id}"
                              >${exercise.visible ? "下架" : "发布"}</button>
                              <button
                                class="button button-danger button-small"
                                data-exercise-action="delete"
                                data-id="${exercise.id}"
                              >永久删除</button>
                            </div>
                          </td>
                        </tr>
                      `,
                    )
                    .join("")
                : '<tr><td colspan="6" class="empty-state">还没有练习。</td></tr>'
            }
          </tbody>
        </table>
      </div>
      <nav class="pagination" aria-label="教师练习题库分页">
        ${paginationMarkup(managedExercisePage, totalPages)}
      </nav>
    </article>
  `;

  document
    .querySelector("#exercise-upload-form")
    .addEventListener("submit", handleExerciseUpload);
  document.querySelectorAll("[data-exercise-action]").forEach((button) => {
    button.addEventListener("click", () => handleExerciseAction(button));
  });
  panel.querySelectorAll("[data-managed-page]").forEach((button) => {
    button.addEventListener("click", () => {
      managedExercisePage = Number(button.dataset.managedPage);
      renderExerciseManagement();
      document
        .querySelector("#tab-exercises .data-table")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  panel.querySelector("[data-managed-page-select]")?.addEventListener("change", (event) => {
    managedExercisePage = Number(event.currentTarget.value);
    renderExerciseManagement();
    document
      .querySelector("#tab-exercises .data-table")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function refreshExerciseViews() {
  ({ exercises } = await api("/api/exercises"));
  await loadExerciseManagement();
  currentReview = null;
  document.querySelector("#review-panel")?.replaceChildren();
  if (exercises.length) {
    await loadAttempts(exercises[0].id);
    await loadStats(exercises[0].id);
  } else {
    renderSubmissions();
    renderStats();
  }
}

async function handleExerciseUpload(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.querySelector('input[name="package"]').files[0];
  const button = form.querySelector('button[type="submit"]');
  const resultBox = document.querySelector("#exercise-upload-result");
  if (!file) return;
  button.disabled = true;
  button.textContent = "正在检查…";
  try {
    const response = await fetch("/api/teacher/exercises/import", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/zip" },
      body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "导入失败。");
    const imported = payload.exercise;
    resultBox.className = "notice notice-success";
    resultBox.innerHTML = `
      <strong>导入成功：${escapeHtml(imported.title)}</strong><br />
      <span class="helper">
        ${imported.questionCount} 题，${formatNumber(imported.totalPoints)} 分；
        选择 ${imported.modes.mcq}，数值填空 ${imported.modes.numeric}，
        文本填空 ${imported.modes.text}，主观 ${imported.modes.manual}。
      </span>
    `;
    form.reset();
    toast(imported.visible ? "练习已导入并发布。" : "练习已导入为草稿。");
    await refreshExerciseViews();
  } catch (error) {
    resultBox.className = "notice notice-error";
    resultBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "检查并导入";
  }
}

async function handleExerciseAction(button) {
  const exercise = managedExercises.find((item) => item.id === Number(button.dataset.id));
  if (!exercise) return;
  try {
    if (button.dataset.exerciseAction === "visibility") {
      await api(`/api/teacher/exercises/${exercise.id}/visibility`, {
        method: "PATCH",
        body: JSON.stringify({ visible: !exercise.visible }),
      });
      toast(exercise.visible ? "练习已下架，历史数据仍保留。" : "练习已发布。");
      await refreshExerciseViews();
      return;
    }

    const warning =
      `将永久删除“${exercise.title}”。\n\n` +
      `同时删除：${exercise.question_count} 道题、${exercise.attempt_count} 位学生的作答、` +
      `${exercise.response_count} 份答案和 ${exercise.grading_count} 项评分。\n\n` +
      "删除前系统会自动备份数据库。是否继续？";
    if (!window.confirm(warning)) return;
    const confirmation = window.prompt(`请输入练习 slug 以确认永久删除：\n${exercise.slug}`);
    if (confirmation !== exercise.slug) {
      toast("确认文字不一致，已取消删除。", "error");
      return;
    }
    const result = await api(`/api/teacher/exercises/${exercise.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    });
    toast(`已永久删除；删除前备份：${result.backup}`);
    await refreshExerciseViews();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function initialize() {
  ({ exercises } = await api("/api/exercises"));
  await Promise.all([loadUsers(), loadExerciseManagement()]);
  if (exercises.length) {
    await loadAttempts(exercises[0].id);
    await loadStats(exercises[0].id);
  } else {
    renderSubmissions();
    renderStats();
  }
}

try {
  await initialize();
} catch (error) {
  toast(error.message, "error");
}
