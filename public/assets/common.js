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

export function initializeImagePreviews() {
  if (document.querySelector("[data-image-lightbox]")) return;

  const lightbox = document.createElement("div");
  lightbox.className = "image-lightbox hidden";
  lightbox.dataset.imageLightbox = "";
  lightbox.innerHTML = `
    <section class="image-lightbox-panel" role="dialog" aria-modal="true" aria-labelledby="image-lightbox-caption">
      <button class="image-lightbox-close" type="button" aria-label="关闭大图">×</button>
      <img alt="" />
      <p id="image-lightbox-caption" class="image-lightbox-caption"></p>
    </section>
  `;
  document.body.append(lightbox);

  const preview = lightbox.querySelector("img");
  const caption = lightbox.querySelector(".image-lightbox-caption");
  const closeButton = lightbox.querySelector(".image-lightbox-close");
  let previousFocus = null;

  function decorateImages(root = document) {
    const images = [];
    if (root instanceof Element && root.matches(".markdown img")) images.push(root);
    root.querySelectorAll?.(".markdown img").forEach((image) => images.push(image));
    images.forEach((image) => {
      image.classList.add("previewable-image");
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-label", `${image.alt || "题目图片"}，点击查看大图`);
      image.title = "点击查看大图";
    });
  }

  function openPreview(source, description, trigger) {
    previousFocus = trigger;
    preview.src = source;
    preview.alt = description || "题目大图";
    caption.textContent = description || "题目图片";
    lightbox.classList.remove("hidden");
    document.body.classList.add("image-lightbox-open");
    closeButton.focus();
  }

  function closePreview() {
    if (lightbox.classList.contains("hidden")) return;
    lightbox.classList.add("hidden");
    document.body.classList.remove("image-lightbox-open");
    preview.removeAttribute("src");
    previousFocus?.focus();
    previousFocus = null;
  }

  function assetLinkFrom(target) {
    const link = target.closest?.('.markdown a[href^="/exercise-assets/"]');
    return link && !link.querySelector("img") ? link : null;
  }

  document.addEventListener("click", (event) => {
    const image = event.target.closest?.(".markdown img");
    const assetLink = assetLinkFrom(event.target);
    if (image) {
      event.preventDefault();
      event.stopPropagation();
      openPreview(image.currentSrc || image.src, image.alt, image);
      return;
    }
    if (assetLink) {
      event.preventDefault();
      openPreview(assetLink.href, assetLink.textContent.trim(), assetLink);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePreview();
      return;
    }
    if (!["Enter", " "].includes(event.key)) return;
    const image = event.target.closest?.(".markdown img");
    if (!image) return;
    event.preventDefault();
    openPreview(image.currentSrc || image.src, image.alt, image);
  });

  closeButton.addEventListener("click", closePreview);
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) closePreview();
  });

  decorateImages();
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) decorateImages(node);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
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
