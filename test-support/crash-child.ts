// Processus lancé par les tests : écrit une tâche en cours dans la base,
// puis se tue avec SIGKILL (aucun nettoyage, aucune fermeture de la base).
import { Store } from "../src/memory/store.ts";
import { TaskJournal } from "../src/tasks/journal.ts";

const store = new Store(process.argv[2]);
const journal = new TaskJournal(store.db);

const id = journal.create(1, "chat", "Fais le point sur mes candidatures");
journal.setStatus(id, "running");
journal.setSession(id, "sess-kill");
journal.announceStep({ taskId: id, toolUseId: "k1", tool: "Read", input: { file_path: "/tmp/clark-ws/n1.md" }, tier: "workspace" });
journal.completeStep("k1", "note 1", false);
journal.announceStep({ taskId: id, toolUseId: "k2", tool: "Write", input: { file_path: "/tmp/clark-ws/relances.md" }, tier: "workspace" });

process.kill(process.pid, "SIGKILL");
