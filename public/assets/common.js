export async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败，请稍后重试。");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function showMessage(element, message, type = "error") {
  if (!element) return;
  element.textContent = message;
  element.className = `notice ${type === "success" ? "notice-success" : "notice-error"}`;
  element.classList.remove("hidden");
}

export function clearMessage(element) {
  element?.classList.add("hidden");
}

export function toast(message, type = "success") {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.append(stack);
  }
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  stack.append(item);
  setTimeout(() => item.remove(), 3200);
}

export async function getSession(expectedRole) {
  try {
    const payload = await api("/api/me");
    if (expectedRole && payload.user.role !== expectedRole) {
      window.location.href = payload.user.role === "teacher" ? "/teacher.html" : "/student.html";
      return null;
    }
    return payload.user;
  } catch (error) {
    if (error.status === 401) {
      window.location.href = "/";
      return null;
    }
    throw error;
  }
}

export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } finally {
    window.location.href = "/";
  }
}

export function bindLogout() {
  document.querySelector("[data-logout]")?.addEventListener("click", logout);
}

export function setUserLabel(user) {
  const label = document.querySelector("[data-user-label]");
  if (label) label.textContent = user.username;
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

export function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "—";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function statusChip(status, label) {
  const className =
    status === "published"
      ? "chip-success"
      : status === "grading"
        ? "chip-warning"
        : status === "draft"
          ? ""
          : "chip-error";
  return `<span class="chip ${className}">${escapeHtml(label)}</span>`;
}
