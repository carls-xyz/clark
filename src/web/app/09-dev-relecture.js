// ── Relecture du diff : commentaires, clavier, retour à la ligne ──

const rowInfo = (row) => {
  const card = row.closest("[data-dev]");
  const file = row.closest("[data-diff-file]").dataset.diffFile;
  return { task: Number(card.dataset.dev), file, side: row.dataset.side, line: Number(row.dataset.line) };
};

function snippetOf(taskId, file, side, start, end) {
  const box = document.querySelector(`[data-dev="${taskId}"] [data-diff-file="${CSS.escape(file)}"]`);
  return [...(box?.querySelectorAll(`.dl[data-side="${side}"]`) ?? [])]
    .filter((r) => Number(r.dataset.line) >= start && Number(r.dataset.line) <= end)
    .map((r) => r.querySelector(".dl-text").textContent.replace(/^ $/, ""))
    .join("\n");
}

function startComment(row, extend) {
  const info = rowInfo(row);
  if (extend && commentDraft && commentDraft.task === info.task && commentDraft.file === info.file && commentDraft.side === info.side) {
    commentDraft.start = Math.min(commentDraft.start, info.line);
    commentDraft.end = Math.max(commentDraft.end, info.line);
  } else commentDraft = { task: info.task, file: info.file, side: info.side, start: info.line, end: info.line };
  const typed = $("#comment-text")?.value ?? "";
  renderView();
  const ta = $("#comment-text");
  if (ta) {
    ta.value = typed;
    ta.focus();
  }
}

async function saveComment(form) {
  const body = form.elements.body.value.trim();
  if (!body) return form.elements.body.focus();
  const d = commentDraft;
  try {
    await post(`/api/dev/tasks/${d.task}`, { action: "comment", file: d.file, side: d.side, start: d.start, end: d.end, snippet: snippetOf(d.task, d.file, d.side, d.start, d.end), body });
    commentDraft = null;
    renderView();
    // La ligne commentée reprend le focus (après le rendu, qui a remplacé l'ancienne).
    document.querySelector(`[data-dev="${d.task}"] [data-diff-file="${CSS.escape(d.file)}"] .dl[data-side="${d.side}"][data-line="${d.end}"]`)?.focus();
    $("#announce").textContent = "Commentaire enregistré";
  } catch (err) {
    form.querySelector(".inline-error")?.remove();
    form.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
}

side.addEventListener("click", async (e) => {
  const add = e.target.closest("[data-comment-line]");
  if (add) return startComment(add.closest(".dl"), e.shiftKey);
  const row = e.target.closest(".dl[data-line]");
  if (row && e.shiftKey && commentDraft) return startComment(row, true);
  if (e.target.closest("[data-comment-cancel]")) {
    commentDraft = null;
    return renderView();
  }
  const act = e.target.closest("[data-comment-act]");
  if (act) {
    act.disabled = true;
    await post(`/api/dev/comments/${act.closest("[data-comment]").dataset.comment}`, { action: act.dataset.commentAct }).catch((err) => {
      act.disabled = false;
      act.insertAdjacentHTML("afterend", ` <span class="inline-error" role="alert">${esc(err.message)}</span>`);
    });
    return;
  }
  const send = e.target.closest("[data-diff-send]");
  if (send) {
    send.disabled = true;
    const id = send.closest("[data-dev]").dataset.dev;
    await post(`/api/dev/tasks/${id}`, { action: "review" }).catch((err) => {
      send.disabled = false;
      send.insertAdjacentHTML("afterend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    });
    return;
  }
  const go = e.target.closest("[data-diff-goto]");
  if (go) {
    const card = go.closest("[data-dev]");
    const details = card.querySelector("[data-dev-diff]");
    if (!details.open) details.open = true;
    const target = () => card.querySelector(`#df-${card.dataset.dev}-${go.dataset.diffGoto}`);
    for (let i = 0; i < 40 && !target(); i++) await new Promise((r) => setTimeout(r, 50));
    target()?.scrollIntoView({ block: "start" });
    target()?.focus({ preventScroll: true });
  }
});

side.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-comment-form]");
  if (!form) return;
  e.preventDefault();
  void saveComment(form);
});

side.addEventListener("change", (e) => {
  if (!e.target.matches("[data-diff-wrap]")) return;
  diffWrap = e.target.checked;
  try {
    localStorage.setItem("clark.diffWrap", diffWrap ? "1" : "0");
  } catch {}
  document.querySelectorAll(".diff").forEach((d) => d.classList.toggle("wrap", diffWrap));
});

// j/k : fichier suivant / précédent ; n/p : changement suivant / précédent ; c : commenter la ligne ; dans un diff ouvert.
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("[data-comment-form]")) {
    if (e.key === "Escape") {
      e.preventDefault();
      commentDraft = null;
      renderView();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void saveComment(e.target.closest("[data-comment-form]"));
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (!["j", "k", "n", "p", "c"].includes(e.key)) return;
  const diff = (document.activeElement?.closest?.("[data-dev-diff][open]") ?? document.querySelector(".view:not([hidden]) [data-dev-diff][open]"));
  if (!diff) return;
  const here = document.activeElement;
  if (e.key === "c") {
    if (here?.matches?.(".dl[data-line]") && here.querySelector("[data-comment-line]")) {
      e.preventDefault();
      startComment(here, false);
    }
    return;
  }
  const items = [...diff.querySelectorAll(e.key === "j" || e.key === "k" ? ".diff-file" : ".dl.d-add, .dl.d-del")];
  if (!items.length) return;
  e.preventDefault();
  // Le suivant (ou le précédent) après l'élément qui a le focus, dans l'ordre du document.
  const inside = here && diff.contains(here);
  const isAfter = (el) => inside && here !== el && Boolean(here.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const forward = e.key === "j" || e.key === "n";
  const next = forward ? (inside ? (items.find(isAfter) ?? items.at(-1)) : items[0]) : (inside ? (items.filter((el) => el !== here && !isAfter(el)).at(-1) ?? items[0]) : items[0]);
  next.focus();
  next.scrollIntoView({ block: "center" });
});

async function sendForm(form, url, body, errorId) {
  const error = form.querySelector(errorId);
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.textContent = data.error || `Erreur ${res.status}`;
      error.hidden = false;
      const field = data.field && form.elements[data.field];
      if (field?.focus) {
        field.insertAdjacentElement("afterend", error);
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", error.id);
        field.focus();
      }
      return false;
    }
    return true;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    return false;
  } finally {
    submit.disabled = false;
  }
}

side.addEventListener("click", async (e) => {
  if (e.target.closest("[data-project-new]")) {
    projectFormOpen = true;
    renderDev();
    $("#pf-name")?.focus();
    return;
  }
  if (e.target.closest("[data-project-cancel]")) {
    projectFormOpen = false;
    renderDev();
    return;
  }
  const delProject = e.target.closest("[data-project-delete]");
  if (delProject) {
    const li = delProject.closest("[data-project]");
    if (!(await ask("Retirer ce projet de Clark ?", "Ton dépôt n'est pas touché ; Clark ne pourra simplement plus y lancer de tâche.", "Retirer"))) return;
    try {
      await post(`/api/dev/projects/${li.dataset.project}`, { action: "delete" });
    } catch (err) {
      li.querySelector(".inline-error")?.remove();
      li.insertAdjacentHTML("beforeend", `<span class="inline-error" role="alert">${esc(err.message)}</span>`);
    }
    return;
  }
  const groupButton = e.target.closest("[data-group-action]");
  if (groupButton) {
    const card = groupButton.closest("[data-dev-group]");
    if (groupButton.dataset.groupAction === "discard" && !(await ask("Jeter ce groupe ?", "Les branches des sous-tâches acceptées restent dans le dépôt.", "Jeter"))) return;
    groupButton.disabled = true;
    try {
      await post(`/api/dev/groups/${card.dataset.devGroup}`, { action: groupButton.dataset.groupAction });
    } catch (err) {
      groupButton.disabled = false;
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const prOpen = e.target.closest("[data-pr-open]");
  if (prOpen) {
    const key = prOpen.dataset.prOpen;
    const [kind, id] = key.split(":");
    prOpen.disabled = true;
    try {
      const res = await fetch(`/api/dev/${kind}/${id}/pr`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Erreur ${res.status}`);
      prForms.set(key, d);
      renderDev();
      $(`[data-pr-form="${key}"] input`)?.focus();
    } catch (err) {
      prOpen.disabled = false;
      prOpen.insertAdjacentHTML("afterend", `<span class="inline-error" role="alert"> ${esc(err.message)}</span>`);
    }
    return;
  }
  const prCancel = e.target.closest("[data-pr-cancel]");
  if (prCancel) {
    prForms.delete(prCancel.dataset.prCancel);
    renderDev();
    return;
  }
  const button = e.target.closest("[data-dev-action]");
  if (!button) return;
  const card = button.closest("[data-dev]");
  const action = button.dataset.devAction;
  if (action === "unblock" && !(await ask("Autoriser et reprendre ?", `L'agent reprend avec ton accord pour : ${card.querySelector(".dev-blocked p")?.textContent.replace(/^L'agent attend ton accord : /, "") ?? "ce qu'il demande"}. Sa nouvelle version passera par la relecture, puis par toi.`, "Autoriser"))) return;
  if (action === "accept" && button.dataset.openPoints) {
    const n = Number(button.dataset.openPoints);
    const blocking = Number(button.dataset.openBlocking);
    const title = `Accepter malgré ${n} point${n > 1 ? "s" : ""} ouvert${n > 1 ? "s" : ""} ?`;
    const head = `Les deux moteurs ne sont pas d'accord${blocking ? `, dont ${blocking} point${blocking > 1 ? "s" : ""} bloquant${blocking > 1 ? "s" : ""}` : ""}. Points encore ouverts :`;
    if (!(await ask(title, `${head}\n${button.dataset.openList}\n\nUne retouche peut les régler avant d'accepter.`, "Accepter quand même", "Relire d'abord"))) return;
  }
  if (action === "discard" && !(await ask("Jeter cette tâche ?", "Sa copie et sa branche sont supprimées. Ta branche n'est pas touchée.", "Jeter"))) return;
  if (action === "stop" && button.hasAttribute("data-waiting")) {
    if (!(await ask("Annuler ce tour ?", "L'agent n'a pas encore commencé : la demande sort de la file. Une version déjà faite reste à relire.", "Annuler le tour", "Garder"))) return;
  } else if (action === "stop" && !(await ask("Arrêter l'agent ?", "Son tour s'arrête là. Ce qu'il a déjà changé reste dans la copie : tu pourras retoucher, réessayer ou jeter.", "Arrêter"))) return;
  card.querySelectorAll(".card-actions button").forEach((b) => (b.disabled = true));
  try {
    await post(`/api/dev/tasks/${card.dataset.dev}`, { action });
  } catch (err) {
    card.querySelectorAll(".card-actions button").forEach((b) => (b.disabled = false));
    card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  }
});

side.addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-gate-pick]");
  const stop = e.target.closest("[data-stop-task]");
  if (pick) {
    const card = pick.closest("[data-gate]");
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await post(`/api/dev/gates/${card.dataset.gate}`, { resolution: pick.dataset.gatePick });
    } catch (err) {
      card.querySelectorAll("button").forEach((b) => (b.disabled = false));
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
  } else if (stop) {
    if (!(await ask("Arrêter l'agent ?", "Son tour s'arrête là. Une écriture en cours sera à vérifier, rien n'est refait sans toi.", "Arrêter"))) return;
    stop.disabled = true;
    await post(`/api/tasks/${stop.dataset.stopTask}/stop`, {}).catch((err) => {
      stop.disabled = false;
      stop.insertAdjacentHTML("afterend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    });
  }
});

side.addEventListener("submit", async (e) => {
  const gate = e.target.closest("[data-gate-form]");
  if (gate) {
    e.preventDefault();
    const text = gate.elements.resolution.value.trim();
    if (!text) return gate.elements.resolution.focus();
    const card = gate.closest("[data-gate]");
    try {
      await post(`/api/dev/gates/${card.dataset.gate}`, { resolution: text });
    } catch (err) {
      card.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const cmp = e.target.closest("[data-dev-compare]");
  if (cmp) {
    e.preventDefault();
    const card = cmp.closest("[data-dev]");
    const [engine, model] = cmp.elements.engine.value.split("|");
    cmp.querySelectorAll("button, select").forEach((b) => (b.disabled = true));
    try {
      const r = await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "compare", engine, model, effort: cmp.elements.effort.value });
      if (r.id) $("#announce").textContent = `Deuxième version lancée : #${r.id}.`;
    } catch (err) {
      cmp.querySelectorAll("button, select").forEach((b) => (b.disabled = false));
      cmp.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const retry = e.target.closest("[data-dev-retry]");
  if (retry) {
    e.preventDefault();
    const card = retry.closest("[data-dev]");
    const [engine, model] = retry.elements.engine.value.split("|");
    retry.querySelectorAll("button, select").forEach((b) => (b.disabled = true));
    try {
      await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "retry", engine, model, effort: retry.elements.effort.value });
    } catch (err) {
      retry.querySelectorAll("button, select").forEach((b) => (b.disabled = false));
      retry.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
    }
    return;
  }
  const project = e.target.closest("#project-form");
  if (project) {
    e.preventDefault();
    const f = project.elements;
    const ok = await sendForm(project, "/api/dev/projects", { name: f.name.value.trim(), path: f.path.value.trim(), baseBranch: f.baseBranch.value.trim(), testCommand: f.testCommand.value.trim() }, "#pf-error");
    if (ok) {
      projectFormOpen = false;
      renderDev();
    }
    return;
  }
  const task = e.target.closest("#dev-form");
  if (task) {
    e.preventDefault();
    const f = task.elements;
    if (await sendForm(task, "/api/dev/tasks", { projectId: Number(f.projectId.value), instruction: f.instruction.value, engine: f.engine.value, split: f.split.checked }, "#df-error")) {
      f.instruction.value = "";
      f.split.checked = false;
    }
    return;
  }
  const prForm = e.target.closest("[data-pr-form]");
  if (prForm) {
    e.preventDefault();
    const key = prForm.dataset.prForm;
    const [kind, id] = key.split(":");
    const f = prForms.get(key);
    Object.assign(f, { title: prForm.elements.title.value, body: prForm.elements.body.value, sending: true, error: null });
    renderDev();
    try {
      await post(`/api/dev/${kind}/${id}`, { action: "pr", title: f.title, body: f.body });
      prForms.delete(key);
    } catch (err) {
      Object.assign(f, { sending: false, error: err.message });
    }
    renderDev();
    return;
  }
  const retouch = e.target.closest("[data-dev-retouch]");
  if (!retouch) return;
  e.preventDefault();
  const card = retouch.closest("[data-dev]");
  const instruction = retouch.elements.instruction.value.trim();
  if (!instruction) return retouch.elements.instruction.focus();
  retouch.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  try {
    const pick = designPick?.taskId === Number(card.dataset.dev) ? designPick : null;
    const design = pick ? { selector: pick.selector, html: pick.html, css: pick.css, page: pick.page, width: pick.width, shot: pick.shot?.file ?? null } : undefined;
    await post(`/api/dev/tasks/${card.dataset.dev}`, { action: "retouch", instruction, ...(design ? { design } : {}) });
    retouch.elements.instruction.value = "";
    if (pick) {
      designPick = null;
      renderView();
    }
  } catch (err) {
    retouch.insertAdjacentHTML("beforeend", `<p class="inline-error" role="alert">${esc(err.message)}</p>`);
  } finally {
    retouch.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
  }
});

