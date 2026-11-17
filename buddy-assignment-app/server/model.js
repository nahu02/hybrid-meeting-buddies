import { readFile } from "node:fs/promises";
import nspell from "nspell";
import dictionaryEn from "dictionary-en";
import { parseGloveText } from "./algorithms/glove.js";

/**
 * Load the matching model once, at startup: the GloVe word vectors
 * and the English spellchecker.
 *
 * If the GloVe file is missing the service still works, but every
 * similarity is 0, so participants are paired in arbitrary order.
 *
 * @param {string | URL} glovePath
 */
export async function loadModel(glovePath) {
  const spell = nspell(dictionaryEn);

  let embeddings = null;
  try {
    const started = Date.now();
    embeddings = parseGloveText(await readFile(glovePath, "utf8"));
    console.log(
      `Loaded ${embeddings.size} word vectors in ${Date.now() - started} ms`
    );
  } catch (err) {
    console.warn(
      `Could not load GloVe vectors from ${glovePath} (${err.message}); ` +
      "participants will be paired in arbitrary order."
    );
  }

  return { embeddings, spell };
}
