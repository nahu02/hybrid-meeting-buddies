import { useCallback, useEffect, useState } from "react";
import { getView, matchNow, submitAnswers } from "./api";
import "./App.css";

const POLL_MS = 1500;

const ROLE_LABELS = {
  remote: "remote participant",
  buddyDevice: "buddy device",
};

// The link comes from RoundManager.linkFor (server/rounds.js).
function parseLocation() {
  const q = new URLSearchParams(window.location.search);
  const round = q.get("round");
  const participant = q.get("participant");
  return round && participant ? { round, participant } : null;
}

// rounds in these states never change again: stop polling
const isFinal = (view) =>
  view?.status === "done" || view?.status === "superseded";

function App() {
  // the URL never changes while the page is open
  const [loc] = useState(parseLocation);
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  // set as soon as "Find Your Buddy!" is clicked, so the waiting screen
  // shows at once instead of after the server's answer
  const [submitted, setSubmitted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const v = await getView(loc.round, loc.participant);
      setView(v);
      setError(null);
      return v;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [loc]);

  // setTimeout after each response, not setInterval: requests never
  // stack up on a slow connection.
  useEffect(() => {
    if (!loc)
      return;
    const poll = { stopped: false, timer: null };
    async function tick() {
      const v = await refresh();
      if (!poll.stopped && !isFinal(v))
        poll.timer = setTimeout(tick, POLL_MS);
    }
    tick();
    return () => {
      poll.stopped = true;
      clearTimeout(poll.timer);
    };
  }, [loc, refresh]);

  async function run(action) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    setSubmitted(true);
    run(async () => {
      try {
        await submitAnswers(loc.round, loc.participant, drafts);
      } catch (err) {
        // back to the form, which shows the error
        setSubmitted(false);
        throw err;
      }
    });
  }

  function handleMatchNow() {
    run(() => matchNow(loc.round));
  }

  function renderMessage(title, text, spinner = false) {
    return (
      <section className="main-section waiting-section">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        {spinner && <div className="spinner" aria-label={title} />}
      </section>
    );
  }

  function renderForm() {
    return (
      <section className="main-section">
        <header className="app-header">
          <h1>Find Your Meeting Buddy, {view.me.username}</h1>
          <p className="subtitle">
            Answer the questions below and we'll automatically match you
            with your buddy!
          </p>
        </header>

        <form className="answers-section" onSubmit={handleSubmit}>
          <div className="questions-list">
            {view.questions.map((q, index) => (
              <div key={q.id} className="question-card">
                <h3>{`Question ${index + 1}`}</h3>
                <h4>{q.text}</h4>
                <textarea
                  className="participant-answer-input"
                  rows={3}
                  value={drafts[q.id] ?? ""}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [q.id]: e.target.value })}
                  placeholder="Enter answer"
                />
              </div>
            ))}
          </div>

          <div className="action-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Find Your Buddy!
            </button>
          </div>
        </form>
      </section>
    );
  }

  function renderProgress() {
    // until the next poll, the server's list doesn't know yet that
    // we've just answered
    const hasAnswered = (p) =>
      p.answered || (submitted && p.id === view.me.id);
    const answered = view.participants.filter(hasAnswered);
    const canMatchNow = view.status === "collecting" &&
      answered.some((p) => p.role === "remote") &&
      answered.some((p) => p.role === "buddyDevice");

    return (
      <section className="main-section waiting-section">
        <h2>
          {view.status === "matching"
            ? "Computing the buddy assignment…"
            : "Your answers have been submitted!"}
        </h2>
        <p>Please wait while we find your buddy.</p>

        <div className="participants-list">
          {view.participants.map((p) => (
            <div
              key={p.id}
              className={
                "participant-card " + (hasAnswered(p) ? "answered" : "pending")
              }
            >
              <div className="participant-top">
                <span className="participant-name">{p.username}</span>
                <span className="role-label">
                  {ROLE_LABELS[p.role] || p.role}
                </span>
                <span className="answered-badge">
                  {hasAnswered(p) ? "answered" : "waiting…"}
                </span>
              </div>
            </div>
          ))}
        </div>

        {view.error && <p className="status-note">{view.error}</p>}

        <div className="action-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!canMatchNow || busy}
            onClick={handleMatchNow}
            title="Match the participants that have already answered"
          >
            Match with those who answered
          </button>
        </div>
      </section>
    );
  }

  function renderResults() {
    const { buddy, questions, me } = view;
    const mine = view.myAnswers || {};
    return (
      <section className="main-section results-section">
        <header className="app-header">
          <h1>Buddy assignment</h1>
        </header>

        <div className="buddy-callout">
          {buddy
            ? `You are matched with ${buddy.username}!`
            : "You could not be matched this time."}
          <div className="callout-hint">
            Return to the meeting tab to continue; your view has already
            switched there.
          </div>
        </div>

        {buddy && (
          <div className="assigned-pairs-card">
            <h3>Your answers</h3>
            <div className="pairs-list">
              <div className="pair-pill">
                <table className="answers-table">
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>{me.username}</th>
                      <th>{buddy.username}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questions.map((q) => (
                      <tr key={q.id}>
                        <th>{q.text}</th>
                        <td>{mine[q.id]}</td>
                        <td>{buddy.answers[q.id]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </section>
    );
  }

  function render() {
    if (!loc) {
      return renderMessage("Buddy assignment",
        "Open this page through the link the meeting gave you.");
    }
    if (!view) {
      return error
        ? renderMessage("Could not load the assignment", error)
        : renderMessage("Loading…", null, true);
    }
    switch (view.status) {
    case "superseded":
      return renderMessage("This assignment was restarted",
        "Use the new link in the meeting tab.");
    case "done":
      return renderResults();
    case "starting":
      return renderMessage("Starting…", null, true);
    default: // collecting, matching
      return view.me.answered || submitted
        ? renderProgress()
        : renderForm();
    }
  }

  return (
    <div className="app-container">
      {error && view && <p className="error-note">{error}</p>}
      {render()}
    </div>
  );
}

export default App;
