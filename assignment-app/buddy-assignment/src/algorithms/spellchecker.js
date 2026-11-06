import nspell from "nspell";

/**
 * Load the English Hunspell dictionary files and initialize nspell.
 * @param {string} baseUrl
 * @returns {Promise<any | null>}
 */
export async function loadSpellChecker(baseUrl = "") {
  try {
    const cleanBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const affUrl = `${cleanBase}dictionaries/en/index.aff`;
    const dicUrl = `${cleanBase}dictionaries/en/index.dic`;

    const [affRes, dicRes] = await Promise.all([
      fetch(affUrl),
      fetch(dicUrl)
    ]);

    if (!affRes.ok || !dicRes.ok) {
      console.warn("Could not fetch spellchecker dictionaries from", affUrl, dicUrl);
      return null;
    }

    const [affText, dicText] = await Promise.all([
      affRes.text(),
      dicRes.text()
    ]);

    return nspell(affText, dicText);
  } catch (error) {
    console.warn("Spellchecker initialization error:", error);
    return null;
  }
}

/**
 * Check spelling of each word in a sentence and suggest/replace corrections.
 * Directly corresponds to check_spelling in glove_test.py:
 *
 * def check_spelling(sentence):
 *     words = sentence.split()
 *     corrected_words = []
 *     for word in words:
 *         corrected_word = spell.correction(word)
 *         corrected_words.append(corrected_word)
 *     return " ".join(corrected_words)
 *
 * @param {string} sentence
 * @param {any} spell
 * @returns {string}
 */
export function checkSpelling(sentence, spell) {
  if (!sentence) return "";
  if (!spell) return sentence;

  const words = sentence.split(/\s+/);
  const correctedWords = [];

  for (const word of words) {
    if (!word) continue;

    // Separate leading/trailing punctuation
    const match = word.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9']+)([^a-zA-Z0-9]*)$/);
    if (!match) {
      correctedWords.push(word);
      continue;
    }

    const [, prefix, cleanWord, suffix] = match;

    // Check if the word is already spelled correctly
    if (spell.correct(cleanWord) || spell.correct(cleanWord.toLowerCase())) {
      correctedWords.push(word);
      continue;
    }

    // Get suggestions
    const suggestions = spell.suggest(cleanWord);
    let corrected = cleanWord;

    if (suggestions && suggestions.length > 0) {
      const topSuggestion = suggestions[0];
      // Preserve capitalization if the original was capitalized
      if (cleanWord[0] === cleanWord[0].toUpperCase() && topSuggestion.length > 0) {
        corrected = topSuggestion[0].toUpperCase() + topSuggestion.slice(1);
      } else {
        corrected = topSuggestion;
      }
    }

    correctedWords.push(`${prefix}${corrected}${suffix}`);
  }

  return correctedWords.join(" ");
}

