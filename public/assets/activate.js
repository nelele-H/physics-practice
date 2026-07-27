import { api, clearMessage, showMessage } from "./common.js";

const form = document.querySelector("#activate-form");
const message = document.querySelector("#activate-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(message);
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "正在创建账号…";
  try {
    await api("/api/activate", {
      method: "POST",
      body: JSON.stringify({
        token: form.token.value,
        username: form.username.value,
        password: form.password.value,
      }),
    });
    window.location.href = "/student.html";
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    button.disabled = false;
    button.textContent = "激活并登录";
  }
});
