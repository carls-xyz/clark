/**
 * Le modèle des embeddings : paraphrase-multilingual-MiniLM-L12-v2 (français compris, ~120 Mo,
 * vecteurs de 384). Comparé sur la vraie mémoire de Clark à multilingual-e5 (small et base) :
 * meilleur premier résultat, et des scores assez étalés pour fixer un seuil.
 */
export const EMBED_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
/** Préfixes attendus par certains modèles (e5 : « query: » / « passage: ») ; aucun pour celui-ci. */
export const prefixes = (model = process.env.CLARK_EMBED_MODEL ?? EMBED_MODEL) => (/e5/i.test(model) ? { query: "query: ", passage: "passage: " } : { query: "", passage: "" });
