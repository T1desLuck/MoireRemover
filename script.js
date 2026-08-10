// ============================================================
// НАСТРОЙКИ
// ============================================================
const GITHUB_REPO = "T1desLuck/MoireRemover"; // владелец/репозиторий
const GITHUB_BRANCH = "main"; // если ветка называется "master" — поменяйте здесь
const INSTALLER_FILENAME = "MoireRemover_Setup.exe"; // имя .exe в корне репозитория

// Файл лежит прямо в репозитории (не в Releases), поэтому обычная ссылка
// github.com/.../blob/... открывает страницу просмотра, а не скачивает файл.
// raw.githubusercontent.com отдаёт сами байты файла — браузер сохраняет .exe сразу.
(function setupLinks() {
  const repoUrl = `https://github.com/${GITHUB_REPO}`;
  const downloadUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${INSTALLER_FILENAME}`;

  document.querySelectorAll("[data-download]").forEach((el) => {
    el.setAttribute("href", downloadUrl);
    el.setAttribute("download", INSTALLER_FILENAME);
  });
  document.querySelectorAll("[data-repo]").forEach((el) => {
    el.setAttribute("href", repoUrl);
  });
})();

// ---------- before/after compare sliders ----------
function initCompareSliders() {
  document.querySelectorAll(".compare").forEach((el) => {
    const before = el.querySelector(".img-before");
    const range = el.querySelector(".compare-range");
    const handle = el.querySelector(".compare-handle");
    if (!before || !range) return;

    const update = (val) => {
      before.style.clipPath = `inset(0 ${100 - val}% 0 0)`;
      if (handle) handle.style.left = `${val}%`;
    };

    update(range.value || 50);
    range.addEventListener("input", (e) => update(e.target.value));
  });
}

// ---------- scroll reveal ----------
function initReveal() {
  const items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || items.length === 0) {
    items.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  items.forEach((el) => io.observe(el));
}

document.addEventListener("DOMContentLoaded", () => {
  initCompareSliders();
  initReveal();
});
