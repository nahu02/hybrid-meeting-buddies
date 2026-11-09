/**
 * Words that don't influence the similarity result.
 */
export const STOP_WORDS = new Set([
  "i", "me", "my", "the", "a", "an",
  "am", "are", "and", "or",  "to", 
  "of", "in", "on", "like", "enjoy"
]);

/**
 * Parse text content of a GloVe embeddings file.
 * @param {string} text
 * @returns {Map<string, Float32Array>}
 */
export function parseGloveText(text) {
  const embeddings = new Map();
  const lines = text.split(/\r?\n/);
  const total = lines.length;

  for (let i = 0; i < total; i++) {
    const line = lines[i];
    if (!line) continue;

    const firstSpace = line.indexOf(" ");
    if (firstSpace === -1) continue;

    const word = line.slice(0, firstSpace).toLowerCase();
    const vectorParts = line.slice(firstSpace + 1).trim().split(/\s+/);
    const vector = new Float32Array(vectorParts.length);

    let valid = true;
    for (let j = 0; j < vectorParts.length; j++) {
      const val = parseFloat(vectorParts[j]);
      if (Number.isNaN(val)) {
        valid = false;
        break;
      }
      vector[j] = val;
    }

    if (valid && vector.length > 0) {
      embeddings.set(word, vector);
    }
  }

  return embeddings;
}

/**
 * Load GloVe embeddings from a static URL with browser caching.
 * @param {string} url
 * @param {(progress: string) => void} [onProgress]
 * @returns {Promise<Map<string, Float32Array>>}
 */
export async function loadGloveFromUrl(url, onProgress) {
  if (onProgress) onProgress("Downloading glove.6B.50d.txt...");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not load GloVe file from "${url}" (HTTP ${response.status} ${response.statusText}).\n` +
      `Please ensure "glove.6B.50d.txt" is placed in "public/models/glove.6B.50d.txt".`
    );
  }

  if (onProgress) onProgress("Parsing GloVe vectors...");
  const text = await response.text();
  const embeddings = parseGloveText(text);

  if (embeddings.size === 0) {
    throw new Error("GloVe file was loaded but contained 0 valid word vectors.");
  }

  return embeddings;
}

/**
 * Convert sentence into an average word vector.
 *
 * @param {string} sentence
 * @param {Map<string, Float32Array>} embeddings
 * @returns {{ vector: Float32Array | null, words: string[], matchedWords: string[], missingWords: string[] }}
 */
export function sentenceVector(sentence, embeddings) {
  if (!sentence || !embeddings) {
    return { vector: null, words: [], matchedWords: [], missingWords: [] };
  }

  // Split sentence into words and clean punctuation
  const rawWords = sentence.toLowerCase().split(/\s+/);
  const words = rawWords
    .map((word) => word.replace(/^[.,!?]+|[.,!?]+$/g, ""))
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));

  const vectors = [];
  const matchedWords = [];
  const missingWords = [];

  for (const word of words) {
    if (embeddings.has(word)) {
      vectors.push(embeddings.get(word));
      matchedWords.push(word);
    } else {
      missingWords.push(word);
    }
  }

  if (vectors.length === 0) {
    return { vector: null, words, matchedWords, missingWords };
  }

  // Calculate average of word vectors (matching np.mean(vectors, axis=0))
  const dimension = vectors[0].length;
  const meanVector = new Float32Array(dimension);

  for (const vec of vectors) {
    for (let i = 0; i < dimension; i++) {
      meanVector[i] += vec[i];
    }
  }

  for (let i = 0; i < dimension; i++) {
    meanVector[i] /= vectors.length;
  }

  return { vector: meanVector, words, matchedWords, missingWords };
}

/**
 * Calculate cosine similarity between two vectors.
 *
 * @param {Float32Array | number[]} vec1
 * @param {Float32Array | number[]} vec2
 * @returns {number} Value between -1.0 and 1.0 (or 0 if invalid)
 */
export function cosineSimilarity(vec1, vec2) {
  if (!vec1 || !vec2 || vec1.length !== vec2.length) {
    return 0;
  }

  let numerator = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    const a = vec1[i];
    const b = vec2[i];
    numerator += a * b;
    magnitude1 += a * a;
    magnitude2 += b * b;
  }

  const denominator = Math.sqrt(magnitude1) * Math.sqrt(magnitude2);

  if (denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}
