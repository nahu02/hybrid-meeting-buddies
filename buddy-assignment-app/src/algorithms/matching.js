import { checkSpelling } from "./spellchecker.js";
import { sentenceVector, cosineSimilarity } from "./glove.js";

/**
 * Compare all participants pairwise using GloVe embeddings,
 * exactly matching the logic from glove_test.py:
 *
 * for i in range(participants):
 *     text = check_spelling(text)
 *     vector = sentence_vector(text, glove)
 *     vectors.append(vector)
 *
 * for i in range(participants):
 *     for j in range(i + 1, participants):
 *         score = cosine_similarity(vectors[i], vectors[j])
 *         print(f"Participant {i + 1} vs Participant {j + 1}: {score * 100:.2f}%")
 *
 * @param {Array<{ id: string | number, name: string, answer: string }>} participants
 * @param {Map<string, Float32Array>} embeddings
 * @param {any} [spell]
 * @returns {{ processedParticipants: Array<any>, matches: Array<any>, assignedPairs: Array<any>, unmatched: string[] }}
 */
export function compareParticipants(participants, embeddings, spell = null) {
  // 1. Process each participant's answer
  const processedParticipants = participants.map((p) => {
    const rawAnswer = (p.answer || "").trim();

    // Spell checking
    const correctedAnswer = spell ? checkSpelling(rawAnswer, spell) : rawAnswer;

    // GloVe sentence vector calculation
    const vectorResult = sentenceVector(correctedAnswer, embeddings);

    return {
      id: p.id,
      name: p.name,
      rawAnswer,
      correctedAnswer,
      vector: vectorResult ? vectorResult.vector : null,
      words: vectorResult ? vectorResult.words : [],
      matchedWords: vectorResult ? vectorResult.matchedWords : [],
      missingWords: vectorResult ? vectorResult.missingWords : [],
      hasVector: Boolean(vectorResult && vectorResult.vector)
    };
  });

  // 2. Compute pairwise cosine similarity
  const matches = [];

  for (let i = 0; i < processedParticipants.length; i++) {
    for (let j = i + 1; j < processedParticipants.length; j++) {
      const p1 = processedParticipants[i];
      const p2 = processedParticipants[j];

      let score = 0;
      if (p1.vector && p2.vector) {
        score = cosineSimilarity(p1.vector, p2.vector);
      }

      const percentage = (score * 100).toFixed(2);

      matches.push({
        id: `${p1.id}-${p2.id}`,
        participant1: p1.name,
        participant2: p2.name,
        answer1: p1.rawAnswer,
        answer2: p2.rawAnswer,
        corrected1: p1.correctedAnswer,
        corrected2: p2.correctedAnswer,
        score,
        percentage,
        canCompare: Boolean(p1.vector && p2.vector)
      });
    }
  }

  // Sort matches by highest similarity first
  matches.sort((a, b) => b.score - a.score);

  // 3. Compute optimal non-overlapping buddy assignments
  const assigned = new Set();
  const assignedPairs = [];

  for (const match of matches) {
    if (!match.canCompare) continue;
    if (!assigned.has(match.participant1) && !assigned.has(match.participant2)) {
      assigned.add(match.participant1);
      assigned.add(match.participant2);
      assignedPairs.push(match);
    }
  }

  const unmatched = processedParticipants
    .filter((p) => !assigned.has(p.name))
    .map((p) => p.name);

  return {
    processedParticipants,
    matches,
    assignedPairs,
    unmatched
  };
}
