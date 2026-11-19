import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Dossiers de test, avant tout import qui lit l'environnement.
const root = mkdtempSync(join(tmpdir(), "clark-skills-"));
const clarkSkills = join(root, "clark-skills");
const mySkills = join(root, "my-skills");
const commands = join(root, "commands");
process.env.CLARK_SKILLS_DIR = clarkSkills;
process.env.CLARK_CLAUDE_SKILLS_DIR = mySkills;
process.env.CLARK_COMMANDS_DIR = commands;
after(() => rmSync(root, { recursive: true, force: true }));

const { deleteCommand, expandCommand, frontmatter, listCommands, listSkills, readSkill, saveCommand, skillsForPrompt, validateCommand } = await import("../src/skills/library.ts");
const { memoryTools } = await import("../src/memory/tools.ts");
const { Store } = await import("../src/memory/store.ts");

const skill = (dir: string, name: string, head: string, body = "La méthode.") => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\n${head}\n---\n\n${body}\n`);
};

test("en-tête des skills : valeurs simples, entre guillemets, et blocs repliés", () => {
  const { meta, body } = frontmatter('---\nname: ogilvy\ndescription: >\n  Écrire du texte\n  qui vend.\ntitle: "Avec : deux-points"\n---\nCorps');
  assert.deepEqual(meta, { name: "ogilvy", description: "Écrire du texte qui vend.", title: "Avec : deux-points" });
  assert.equal(body, "Corps");
  assert.deepEqual(frontmatter("pas d'en-tête").meta, {});
});

test("skills : les tiens et ceux de Clark, lus sans jamais sortir de leur dossier", () => {
  skill(clarkSkills, "relances", "name: relances\ndescription: Comment écrire une relance");
  skill(mySkills, "ogilvy", "name: ogilvy\ndescription: >-\n  Textes qui vendent");
  skill(mySkills, "relances", "name: relances\ndescription: version perso");
  writeFileSync(join(mySkills, "ogilvy", "regles.md"), "Règle 1");
  writeFileSync(join(root, "secret.txt"), "à ne pas lire");
  symlinkSync(join(root, "secret.txt"), join(mySkills, "ogilvy", "fuite.md"));

  const list = listSkills();
  assert.deepEqual(list.map((s) => [s.name, s.source]), [["relances", "clark"], ["ogilvy", "claude"]], "même nom : celui de Clark passe avant");
  assert.match(skillsForPrompt(), /- ogilvy : Textes qui vendent/);

  const r = readSkill("ogilvy")!;
  assert.match(r.text, /La méthode/);
  assert.ok(r.files.includes("regles.md"));
  assert.equal(readSkill("ogilvy", "regles.md")!.text, "Règle 1");
  assert.equal(readSkill("ogilvy", "../../secret.txt"), null, "pas de remontée de dossier");
  assert.equal(readSkill("ogilvy", "fuite.md"), null, "pas de lien qui sort du skill");
  assert.equal(readSkill("inconnu"), null);

  const s = new Store(":memory:");
  const tool = memoryTools(s, { taskId: () => 1, writeRefusal: () => "lecture seule" }).use_skill;
  assert.match(tool.run({ name: "ogilvy" }), /La méthode[\s\S]*Fichiers du skill : regles\.md/, "permis en lecture seule");
  assert.match(tool.run({ name: "nope" }), /introuvable.*relances, ogilvy/);
});

test("commandes : enregistrées en fichiers, $ARGUMENTS remplacé, noms de Clark réservés", () => {
  assert.equal(validateCommand({ name: "relances", prompt: "Prépare la relance pour $ARGUMENTS" }), null);
  assert.equal(validateCommand({ name: "Relances!", prompt: "Prépare la relance" })?.field, "name");
  assert.match(validateCommand({ name: "objectif", prompt: "Prépare la relance" })!.error, /déjà une commande de Clark/);
  assert.equal(validateCommand({ name: "x", prompt: "court" })?.field, "prompt");

  saveCommand({ name: "relances", description: "Relance une candidature", mode: "chat", prompt: "Prépare la relance pour $ARGUMENTS, sans l'envoyer." });
  saveCommand({ name: "trier", description: "Trie mes mails", mode: "goal", prompt: "Trie mes mails non lus de la semaine." });
  assert.deepEqual(listCommands().map((c) => [c.name, c.mode]), [["relances", "chat"], ["trier", "goal"]]);

  assert.equal(expandCommand("/relances Studio Pixel")!.prompt, "Prépare la relance pour Studio Pixel, sans l'envoyer.");
  assert.equal(expandCommand("/trier en priorité l'IIM")!.prompt, "Trie mes mails non lus de la semaine.\n\nen priorité l'IIM", "sans $ARGUMENTS : ajouté à la fin");
  assert.equal(expandCommand("/relances@clark_bot Agence Onde")!.prompt, "Prépare la relance pour Agence Onde, sans l'envoyer.", "forme Telegram en groupe");
  assert.equal(expandCommand("/inconnue truc"), null);
  assert.equal(expandCommand("Pas une commande"), null);
  assert.ok(deleteCommand("trier"));
  assert.ok(!deleteCommand("trier"));
});

test("commande lancée depuis la conversation : le fil montre la commande, l'agent reçoit sa consigne ; mode objectif respecté", async () => {
  const { Conversation } = await import("../src/core/conversation.ts");
  const { createHub, OWNER_CHAT } = await import("../src/core/hub.ts");
  const { TaskJournal } = await import("../src/tasks/journal.ts");
  const { submitRequest } = await import("../src/core/submit.ts");
  const store = new Store(":memory:");
  const journal = new TaskJournal(store.db);
  const conversation = new Conversation(store.db);
  const prompts: string[] = [];
  const execute = (async (deps: any, taskId: number, opts: any) => {
    prompts.push(opts.prompt);
    deps.journal.finish(taskId, "done", "ok", 0);
    return { text: "ok", costUsd: 0, status: "done" };
  }) as any;
  const config = { telegram: null, hasApiKey: true, engine: "claude", codexModel: null, engineAuto: false, heartbeatMinutes: 0, roleEngines: {}, webPort: 0, model: "m", maxUsdPerTask: 1, maxUsdPerDay: 5, briefHour: null } as any;
  const hub = createHub({ config, store, journal, conversation }, { execute });

  assert.deepEqual(submitRequest(hub, "/relances Studio Pixel", { source: "web" }), { kind: "chat", command: "relances" });
  for (let i = 0; i < 200 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(prompts[0], "Prépare la relance pour Studio Pixel, sans l'envoyer.");
  assert.equal(conversation.recent(OWNER_CHAT).find((m) => m.role === "user")!.text, "/relances Studio Pixel");

  saveCommand({ name: "trier", mode: "goal", prompt: "Trie mes mails non lus de la semaine." });
  assert.equal((submitRequest(hub, "/trier", { source: "telegram" }) as any).kind, "goal");
  assert.equal(store.goals.list()[0].objective, "Trie mes mails non lus de la semaine.");
  assert.deepEqual(submitRequest(hub, "   ", { source: "web" }), { error: "Message vide" });
});
