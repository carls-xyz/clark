// ── Gérer les conversations : renommer, épingler, supprimer, trier ──

let menuConvId = null;
let menuConfirm = false;

function paintConvMenu() {
  const c = (state?.conversations ?? []).find((x) => x.id === menuConvId);
  const menu = $("#conv-menu");
  if (!c) return menu.hidePopover?.();
  menu.innerHTML = menuConfirm
    ? `<p class="conv-menu-note">Supprimer « ${esc(c.title)} » ? Ses messages seront effacés pour de bon (les tâches restent dans Activité).</p>
       <div class="conv-menu-actions">
         <button type="button" class="btn danger" data-conv-act="delete-yes" role="menuitem">Supprimer</button>
         <button type="button" class="btn ghost" data-conv-act="delete-no" role="menuitem">Annuler</button>
       </div>`
    : `<button type="button" class="conv-menu-item" data-conv-act="rename" role="menuitem">Renommer</button>
       <button type="button" class="conv-menu-item" data-conv-act="${c.pinned ? "unpin" : "pin"}" role="menuitem">${c.pinned ? "Désépingler" : "Épingler en haut"}</button>
       <button type="button" class="conv-menu-item is-danger" data-conv-act="delete" role="menuitem">Supprimer…</button>`;
  menu.querySelector("button")?.focus();
}

function openConvMenu(btn) {
  menuConvId = Number(btn.dataset.convMenu);
  menuConfirm = false;
  const menu = $("#conv-menu");
  paintConvMenu();
  menu.showPopover?.();
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelector("button")?.focus();
}

async function convAction(id, action, title) {
  await post(`/api/conversations/${id}`, { action, ...(title !== undefined ? { title } : {}) });
}

$("#threads").addEventListener("click", (e) => {
  const more = e.target.closest("[data-conv-menu]");
  if (more) {
    e.preventDefault();
    return openConvMenu(more);
  }
  if (e.target.closest("[data-conv-rename-cancel]")) {
    renamingId = null;
    renderThreads();
  }
});

$("#conv-menu").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-conv-act]");
  if (!btn) return;
  const id = menuConvId;
  const act = btn.dataset.convAct;
  const menu = $("#conv-menu");
  if (act === "delete") {
    menuConfirm = true;
    return paintConvMenu();
  }
  if (act === "delete-no") {
    menuConfirm = false;
    return paintConvMenu();
  }
  if (act === "rename") {
    menu.hidePopover?.();
    renamingId = id;
    renderThreads();
    const input = $(`#conv-rename-${id}`);
    input?.focus();
    input?.select();
    return;
  }
  btn.disabled = true;
  try {
    await convAction(id, act === "delete-yes" ? "delete" : act);
    menu.hidePopover?.();
    // La conversation supprimée était affichée : on revient à l'ouverte.
    if (act === "delete-yes" && (pastId === id || location.hash === `#conversation/${id}`)) location.hash = "#conversation";
  } catch (err) {
    btn.disabled = false;
    menu.querySelector(".inline-error")?.remove();
    menu.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

$("#conv-menu").addEventListener("toggle", (e) => {
  if (e.newState !== "closed") return;
  // Le focus revient sur le bouton ⋯ de la conversation.
  if (renamingId === null) $(`[data-conv-menu="${menuConvId}"]`)?.focus({ preventScroll: true });
});

$("#threads").addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-conv-rename]");
  if (!form) return;
  e.preventDefault();
  const id = Number(form.dataset.convRename);
  const title = form.elements.title.value.trim();
  if (!title) return form.elements.title.focus();
  try {
    await convAction(id, "rename", title);
    renamingId = null;
    renderThreads();
    $(`[data-conv-menu="${id}"]`)?.focus({ preventScroll: true });
  } catch (err) {
    form.querySelector(".inline-error")?.remove();
    form.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

$("#threads").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.closest("[data-conv-rename]")) {
    const id = renamingId;
    renamingId = null;
    renderThreads();
    $(`[data-conv-menu="${id}"]`)?.focus({ preventScroll: true });
  }
});

$("#threads").addEventListener("change", (e) => {
  if (e.target.id !== "conv-sort") return;
  convSort = e.target.value;
  try {
    localStorage.setItem("clark.convSort", convSort);
  } catch {}
  renderThreads();
  $("#conv-sort")?.focus();
});
