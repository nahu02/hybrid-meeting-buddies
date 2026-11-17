/**
 * Check spelling of each word in a sentence and suggest/replace corrections.
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

