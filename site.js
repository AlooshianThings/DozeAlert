/* Page behaviour: mobile menu, scroll reveal, active nav link. */
(() => {
  "use strict";

  // Mobile menu
  const btn = document.getElementById("menu-btn");
  const menu = document.getElementById("menu");
  function setMenu(open) {
    menu.dataset.open = open ? "true" : "false";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "Close" : "Menu";
  }
  btn.addEventListener("click", () => setMenu(menu.dataset.open !== "true"));
  menu.addEventListener("click", (e) => { if (e.target.tagName === "A") setMenu(false); });

  // Scroll reveal
  const items = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.15 });
    items.forEach((el, i) => {
      el.style.transitionDelay = (i % 3) * 80 + "ms";
      io.observe(el);
    });
  } else {
    items.forEach((el) => el.classList.add("in"));
  }

  // Highlight the nav link of the section on screen
  const links = [...menu.querySelectorAll("a")];
  const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  if ("IntersectionObserver" in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const link = map.get(en.target.id);
        if (link && en.isIntersecting) {
          links.forEach((a) => a.classList.remove("active"));
          link.classList.add("active");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    map.forEach((_, id) => { const s = document.getElementById(id); if (s) spy.observe(s); });
  }
})();
