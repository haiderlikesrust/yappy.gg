(() => {
  // All preview content is local: switching views never contacts the API.
  const tabs = [...document.querySelectorAll("[data-demo]")];
  const activate = (tab, focus = false) => {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden =
        !selected;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft")
        next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        activate(tabs[next], true);
      }
    });
  });
  for (const wave of document.querySelectorAll("[data-wave]")) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < Number(wave.dataset.wave); i++) {
      const bar = document.createElement("i");
      bar.style.setProperty(
        "--bar-height",
        `${24 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.43)) * 76}%`,
      );
      bar.style.setProperty("--bar-delay", `${-(i % 9) * 0.14}s`);
      fragment.append(bar);
    }
    wave.append(fragment);
  }
  const menu = document.querySelector(".mobile-nav");
  menu?.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a"))
      menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu?.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (
      menu?.open &&
      event.target instanceof Node &&
      !menu.contains(event.target)
    )
      menu.open = false;
  });
  document.getElementById("copyright-year").textContent = String(
    new Date().getFullYear(),
  );
})();
