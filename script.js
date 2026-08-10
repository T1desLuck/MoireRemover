// ============================================================
// НАСТРОЙКИ — поменяйте под свой репозиторий
// ============================================================
const GITHUB_REPO = "USERNAME/MoireRemover"; // <-- замените на "владелец/репозиторий"
const INSTALLER_FILENAME = "MoireRemover_Setup.exe"; // имя exe-файла в Releases

(function setupLinks() {
  const repoUrl = `https://github.com/${GITHUB_REPO}`;
  const downloadUrl = `${repoUrl}/releases/latest/download/${INSTALLER_FILENAME}`;
  const releasesUrl = `${repoUrl}/releases`;

  document.querySelectorAll("[data-download]").forEach((el) => {
    el.setAttribute("href", downloadUrl);
  });
  document.querySelectorAll("[data-repo]").forEach((el) => {
    el.setAttribute("href", repoUrl);
  });
  document.querySelectorAll("[data-releases]").forEach((el) => {
    el.setAttribute("href", releasesUrl);
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
