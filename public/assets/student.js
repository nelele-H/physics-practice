import {
  api,
  bindLogout,
  escapeHtml,
  formatNumber,
  getSession,
  setUserLabel,
  statusChip,
  toast,
} from "./common.js";

const user = await getSession("student");
if (!user) throw new Error("未登录");
setUserLabel(user);
bindLogout();

let allExercises = [];
let exerciseQuery = "";
let exercisePage = 1;
const EXERCISES_PER_PAGE = 6;

const passwordPanel = document.querySelector("#password-panel");
document.querySelector("#password-toggle").addEventListener("click", () => {
  passwordPanel.classList.toggle("hidden");
});
if (user.mustChangePassword) {
  passwordPanel.classList.remove("hidden");
  toast("教师已重置你的密码，请先设置新密码。");
}

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: document.querySelector("#current-password").value,
        newPassword: document.querySelector("#new-password").value,
      }),
    });
    toast("密码已修改，请重新登录。");
    setTimeout(() => (window.location.href = "/"), 700);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .trim();
}

function matchesExercise(exercise, query) {
  if (!query) return true;
  return normalizeSearch(
    [exercise.code, exercise.title, exercise.subtitle, exercise.slug].join(" "),
  ).includes(query);
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
              data-exercise-page="${page}"
              aria-label="第 ${page} 页"
              ${page === currentPage ? 'aria-current="page"' : ""}
            >${page}</button>
          `,
    )
    .join("");
  return `
    <button
      class="button button-soft button-small"
      type="button"
      data-exercise-page="${currentPage - 1}"
      ${currentPage === 1 ? "disabled" : ""}
    >上一页</button>
    <div class="pagination-pages">${pageButtons}</div>
    <button
      class="button button-soft button-small"
      type="button"
      data-exercise-page="${currentPage + 1}"
      ${currentPage === totalPages ? "disabled" : ""}
    >下一页</button>
    <form class="pagination-jump" data-exercise-page-jump>
      <label for="exercise-page-input">跳至第</label>
      <input
        class="input pagination-input"
        id="exercise-page-input"
        data-exercise-page-input
        type="number"
        inputmode="numeric"
        min="1"
        max="${totalPages}"
        value="${currentPage}"
        aria-label="输入要跳转的页码"
        required
      />
      <span>页</span>
      <button class="button button-soft button-small" type="submit">跳转</button>
    </form>
    <span class="pagination-status">第 ${currentPage} / ${totalPages} 页</span>
  `;
}

function renderExercises() {
  const filtered = allExercises.filter((exercise) => matchesExercise(exercise, exerciseQuery));
  const totalPages = Math.max(1, Math.ceil(filtered.length / EXERCISES_PER_PAGE));
  exercisePage = Math.min(Math.max(exercisePage, 1), totalPages);
  const pageExercises = filtered.slice(
    (exercisePage - 1) * EXERCISES_PER_PAGE,
    exercisePage * EXERCISES_PER_PAGE,
  );
  const count = document.querySelector("#exercise-search-count");
  count.textContent = exerciseQuery
    ? `找到 ${filtered.length} 套，共 ${allExercises.length} 套${filtered.length ? ` · 第 ${exercisePage}/${totalPages} 页` : ""}`
    : `共 ${allExercises.length} 套练习${allExercises.length ? ` · 第 ${exercisePage}/${totalPages} 页` : ""}`;

  document.querySelector("#exercise-grid").innerHTML = filtered.length
    ? pageExercises
        .map((exercise) => {
          const status =
            exercise.status === "not_started" ? "not_started" : exercise.status || "draft";
          const score =
            status === "published"
              ? `<span class="chip chip-success">${formatNumber(exercise.total_score)} / ${formatNumber(exercise.max_score)} 分</span>`
              : "";
          return `
            <article class="card exercise-card">
              <div class="exercise-card-top">
                <span class="chip">${escapeHtml(exercise.code)}</span>
                ${statusChip(status, exercise.statusLabel)}
              </div>
              <h2>${escapeHtml(exercise.title)}</h2>
              <p>${escapeHtml(exercise.subtitle)}</p>
              <div class="exercise-meta">
                <span class="chip">${exercise.question_count} 个可作答小题</span>
                <span class="chip">已写 ${Number(exercise.answered_count || 0)} 题</span>
                ${score}
              </div>
              <a class="button button-primary" href="${escapeHtml(exercise.page)}">
                ${status === "published" ? "查看成绩" : status === "grading" ? "查看锁定状态" : "进入练习"}
              </a>
            </article>
          `;
        })
        .join("")
    : `
        <div class="card card-pad empty-search">
          <strong>${allExercises.length ? "没有找到相关练习" : "老师暂未分配作业"}</strong>
          <p>${
            allExercises.length
              ? "换一个更短的关键词试试，例如“1A”或“能量”。"
              : "老师分配并发布作业后，会显示在这里。"
          }</p>
        </div>
      `;

  const pagination = document.querySelector("#exercise-pagination");
  pagination.innerHTML = filtered.length ? paginationMarkup(exercisePage, totalPages) : "";
  pagination.querySelectorAll("[data-exercise-page]").forEach((button) => {
    button.addEventListener("click", () => {
      exercisePage = Number(button.dataset.exercisePage);
      renderExercises();
      document.querySelector("#exercise-grid").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  pagination.querySelector("[data-exercise-page-jump]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("[data-exercise-page-input]");
    if (!input.reportValidity()) return;
    exercisePage = Math.min(totalPages, Math.max(1, Number.parseInt(input.value, 10)));
    renderExercises();
    document.querySelector("#exercise-grid").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function loadExercises() {
  ({ exercises: allExercises } = await api("/api/exercises"));
  const started = allExercises.filter((exercise) => Number(exercise.answered_count) > 0).length;
  const grading = allExercises.filter((exercise) => exercise.status === "grading").length;
  const published = allExercises.filter((exercise) => exercise.status === "published").length;

  document.querySelector("#summary").innerHTML = `
    <article class="summary-card">
      <span>已开始练习</span>
      <strong>${started}</strong>
    </article>
    <article class="summary-card">
      <span>教师批改中</span>
      <strong>${grading}</strong>
    </article>
    <article class="summary-card">
      <span>已发布成绩</span>
      <strong>${published}</strong>
    </article>
  `;

  renderExercises();
}

document.querySelector("#exercise-search").addEventListener("input", (event) => {
  exerciseQuery = normalizeSearch(event.currentTarget.value);
  exercisePage = 1;
  renderExercises();
});

try {
  await loadExercises();
} catch (error) {
  document.querySelector("#exercise-grid").innerHTML =
    `<div class="notice notice-error">${escapeHtml(error.message)}</div>`;
}
