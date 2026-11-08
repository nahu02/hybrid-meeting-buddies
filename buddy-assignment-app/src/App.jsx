import { useState, useEffect } from "react";
import { loadGloveFromUrl } from "./algorithms/glove";
import { loadSpellChecker } from "./algorithms/spellchecker";
import { compareParticipants } from "./algorithms/matching";
import { PARTICIPANTS_COUNT, GLOVE_MODEL_PATH } from "./config";
import "./App.css";

function createParticipants(count) {
  const safeCount = Math.max(2, Number(count) || 2);
  const list = [];
  for (let i = 1; i <= safeCount; i++) {
    list.push({
      id: i,
      name: `Participant ${i}`,
    });
  }
  return list;
}

function App() {
  const [embeddings, setEmbeddings] = useState(null);
  const [loadingModel, setLoadingModel] = useState(true);

  const [spell, setSpell] = useState(null);

  const [participants, setParticipants] = useState(() => createParticipants(PARTICIPANTS_COUNT));
  const [matchResult, setMatchResult] = useState(null);

  // Initialize GloVe model and spellchecker on mount
  useEffect(() => {
    async function init() {
      // 1. Initialize spellchecker
      try {
        const checker = await loadSpellChecker(import.meta.env.BASE_URL);
        setSpell(checker);
      } catch (err) {
        console.warn("Could not load spellchecker dictionary:", err);
      }

      // 2. Load local GloVe embeddings file in the background
      try {
        setLoadingModel(true);
        const glove = await loadGloveFromUrl(GLOVE_MODEL_PATH);
        setEmbeddings(glove);
      } catch (err) {
        console.error("Failed to load embeddings:", err);
      } finally {
        setLoadingModel(false);
      }
    }

    init();
  }, []);

  // Update participant details
  function updateParticipant(id, field, value) {
    setParticipants((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  }

  // Execute matching using local GloVe embeddings
  function handleFindMatches() {
    if (!embeddings) return;
    const result = compareParticipants(participants, embeddings, spell);
    setMatchResult(result);
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Find Your Meeting Buddy</h1>
        <p className="subtitle">
          Answer the questions below and we'll automatically match you with your buddy!
        </p>
      </header>

      {/* Participants Input Section */}
      <section className="main-section">
        <div className="section-header">
          <div>
            <h2>Participants &amp; Answers</h2>
          </div>
        </div>

        <div className="participants-list">
          {participants.map((p, index) => (
            <div key={p.id} className="participant-card">
              <div className="participant-top">
                <input
                  type="text"
                  className="participant-name-input"
                  value={p.name}
                  onChange={(e) => updateParticipant(p.id, "name", e.target.value)}
                  placeholder={`Participant ${index + 1}`}
                />
              </div>
              <textarea
                className="participant-answer-input"
                rows={2}
                value={p.answer}
                onChange={(e) => updateParticipant(p.id, "answer", e.target.value)}
                placeholder="Enter answer"
              />
            </div>
          ))}
        </div>

        <div className="action-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!embeddings || loadingModel}
            onClick={handleFindMatches}
          >
            {loadingModel ? "Initializing..." : "Find Buddy Matches"}
          </button>
        </div>
      </section>

      {/* Results Section */}
      {matchResult && (
        <section className="results-section">
          {/* Top Match Highlight Banner */}
          {matchResult.matches.length > 0 && matchResult.matches[0].canCompare && (
            <div className="best-match-banner">
              <div className="best-match-content">
                <span className="best-match-title">Top Match</span>
                <h3>
                  {matchResult.matches[0].participant1} &amp; {matchResult.matches[0].participant2}
                </h3>
                <p>
                  Compatibility: <strong>{matchResult.matches[0].percentage}%</strong>
                </p>
              </div>
            </div>
          )}

          {/* Suggested Buddy Assignments */}
          {matchResult.assignedPairs && matchResult.assignedPairs.length > 0 && (
            <div className="assigned-pairs-card">
              <h3>Suggested Buddy Assignments</h3>
              <p className="pairs-desc">
                Optimal buddy pairings based on answer similarity:
              </p>
              <div className="pairs-list">
                {matchResult.assignedPairs.map((pair, idx) => (
                  <div key={idx} className="pair-pill">
                    <span className="pair-names">
                      <strong>{pair.participant1}</strong> &harr; <strong>{pair.participant2}</strong>
                    </span>
                    <span className="pair-score">{pair.percentage}% match</span>
                  </div>
                ))}
                {matchResult.unmatched && matchResult.unmatched.length > 0 && (
                  <div className="unmatched-note">
                    Unpaired participant: {matchResult.unmatched.join(", ")}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default App;
