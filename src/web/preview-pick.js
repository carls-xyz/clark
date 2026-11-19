// Ajouté par Clark aux pages de l'aperçu (mode design). Inactif tant que l'interface de Clark ne
// le demande pas. Choisir un élément envoie son HTML, ses styles calculés et un sélecteur à
// l'interface de Clark, et à elle seule (CLARK_PARENTS, posé par le serveur d'aperçu).
(() => {
  if (window.top === window) return;
  const PROPS = [
    "display", "position", "box-sizing", "width", "height", "margin", "padding", "border", "border-radius",
    "color", "background-color", "background-image", "opacity", "box-shadow",
    "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform", "text-decoration-line",
    "gap", "flex-direction", "justify-content", "align-items", "grid-template-columns", "overflow", "z-index",
  ];
  let on = false;
  let box = null;

  const send = (msg) => {
    for (const origin of CLARK_PARENTS) {
      try {
        parent.postMessage(msg, origin);
      } catch {}
    }
  };

  const cssPath = (el) => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const tag = n.tagName.toLowerCase();
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    }
    return parts.join(" > ");
  };

  const outline = () => {
    if (box) return box;
    box = document.createElement("div");
    box.setAttribute("data-clark-pick", "");
    Object.assign(box.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483647", outline: "2px solid #2448c4", outlineOffset: "-1px", background: "rgb(36 72 196 / 0.08)", display: "none" });
    document.documentElement.appendChild(box);
    return box;
  };

  const place = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(outline().style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };

  const stop = () => {
    on = false;
    if (box) box.style.display = "none";
    document.documentElement.style.cursor = "";
  };

  addEventListener("message", (e) => {
    if (!CLARK_PARENTS.includes(e.origin) || e.data?.type !== "clark-pick") return;
    if (e.data.on) {
      on = true;
      document.documentElement.style.cursor = "crosshair";
    } else stop();
  });

  addEventListener(
    "mousemove",
    (e) => {
      if (on && e.target instanceof Element && !e.target.hasAttribute("data-clark-pick")) place(e.target);
    },
    true,
  );

  addEventListener(
    "click",
    (e) => {
      if (!on || !(e.target instanceof Element)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      const cs = getComputedStyle(el);
      const css = {};
      for (const p of PROPS) {
        const v = cs.getPropertyValue(p);
        if (v) css[p] = v;
      }
      const r = el.getBoundingClientRect();
      send({
        type: "clark-picked",
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
        html: el.outerHTML.slice(0, 6000),
        css,
        size: { width: Math.round(r.width), height: Math.round(r.height) },
        page: location.pathname + location.search,
        width: innerWidth,
      });
      stop();
    },
    true,
  );

  addEventListener("keydown", (e) => {
    if (on && e.key === "Escape") {
      stop();
      send({ type: "clark-pick-cancel" });
    }
  });

  send({ type: "clark-preview-ready", page: location.pathname + location.search });
})();
