import { api, clearMessage, showMessage } from "./common.js";

const form = document.querySelector("#login-form");
const message = document.querySelector("#login-message");

try {
  const session = await api("/api/me");
  window.location.href = session.user.role === "teacher" ? "/teacher.html" : "/student.html";
} catch {
  // 未登录时停留在登录页面。
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(message);
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "正在登录…";
  try {
    const payload = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    window.location.href = payload.user.role === "teacher" ? "/teacher.html" : "/student.html";
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    button.disabled = false;
    button.textContent = "登录";
  }
});
