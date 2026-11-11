import { useCallback, useEffect, useRef, useState } from "react";
import { loadGloveFromUrl } from "./algorithms/glove";
import { loadSpellChecker } from "./algorithms/spellchecker";
import { matchBuddies } from "./algorithms/matching";
import {
  ControllerConnection,
  answersOf,
  electController,
  parseAssignmentLocation,
} from "./galene";
import { QUESTIONS_COUNT, GLOVE_MODEL_PATH } from "./config";
import "./App.css";

function createQuestions(count) {
  const safeCount = Math.max(1, Number(count) || 2);
  const list = [];
  for (let i = 1; i <= safeCount; i++) {
    list.push({
      id: i,
      answer: ""
    });
  }
  return list;
}

function hasCompleteAssignment(participants, controllers) {
  const answered = participants.filter(
    (p) => answersOf(controllers, p.id)
  );
  const remotes = answered.filter((p) => p.role === "remote");
  const buddies = answered.filter((p) => p.role === "buddyDevice");
  const expectedPairs = Math.min(remotes.length, buddies.length);
  if (expectedPairs === 0) return false;

  const byId = new Map(participants.map((p) => [p.id, p]));
  const reciprocalPairs = remotes.filter((p) => {
    if (!p.assignedTo) return false;
    const buddy = byId.get(p.assignedTo);
    return buddy?.role === "buddyDevice" && buddy.assignedTo === p.id;
  }).length;
  return reciprocalPairs === expectedPairs;
}

const sampleQuestions =
  [
    "What hobby or skill would you like to learn?",
    "What superpower would you like to have?",
    "What movie, book, or show have you enjoyed recently?"
  ]

const ROLE_LABELS = {
  remote: "remote participant",
  buddyDevice: "buddy device",
};

function App() {
  // the URL (/assignment/<group>/<id>?role=<role>) never changes
  const [location] = useState(() => parseAssignmentLocation());
  const [phase, setPhase] = useState(() =>
    location ? "connecting" : "badUrl"
  );
  const [loginError, setLoginError] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [questions, setQuestions] = useState(
    () => createQuestions(QUESTIONS_COUNT)
  );
  const [snapshot, setSnapshot] = useState(null);
  const [localResult, setLocalResult] = useState(null);
  const [modelState, setModelState] = useState("loading");
  const [connError, setConnError] = useState(null);

  // mirrors of the state above, readable from the (stable) event
  // handlers below
  const phaseRef = useRef(phase);
  const locRef = useRef(location);
  const questionsRef = useRef(questions);
  const snapshotRef = useRef(null);
  const modelRef = useRef({
    state: "loading",
    embeddings: null,
    spell: null,
  });
  const localResultRef = useRef(null);
  const matchedRef = useRef(false);
  const connRef = useRef(null);

  function goTo(next) {
    phaseRef.current = next;
    setPhase(next);
  }

  function updateAnswer(questionId, value) {
    setQuestions((prev) => {
      const next = prev.map((q) =>
        q.id === questionId ? { ...q, answer: value } : q);
      questionsRef.current = next;
      return next;
    });
  }

  // Pair the participants that have submitted answers.  Uses the
  // matching model if it has been downloaded, and joins the remaining
  // participants in arbitrary order otherwise.
  function computeMatching(snap) {
    const { embeddings, spell } = modelRef.current;
    const answered = snap.participants
      .filter((p) => answersOf(snap.controllers, p.id))
      .map((p) => ({
        ...p,
        answers: answersOf(snap.controllers, p.id),
      }));
    return matchBuddies(
      answered.filter((p) => p.role === "remote"),
      answered.filter((p) => p.role === "buddyDevice"),
      questionsRef.current,
      embeddings,
      spell
    );
  }

  function applyMatching(snap) {
    const result = computeMatching(snap);
    localResultRef.current = result;
    setLocalResult(result);
    goTo(result.pairs.length > 0 ? "applying" : "results");
    if (result.pairs.length > 0) {
      connRef.current?.assignBuddies(
        result.pairs.map((p) => ({
          remote: p.remoteId,
          buddyDevice: p.buddyDeviceId,
        }))
      );
    }
  }

  // The heart of the controller: called on every change of the user
  // list.  When everybody has answered, one deterministic controller
  // (participant id, then controller id)
  // computes the assignment and applies it; the others follow the
  // server's user messages into the results view.
  const handleUsers = useCallback((snap) => {
    snapshotRef.current = snap;
    const phase = phaseRef.current;
    const { participants, controllers } = snap;

    if (phase !== "progress" && phase !== "applying" &&
        phase !== "results")
      return;

    if ((phase === "progress" || phase === "applying") &&
        hasCompleteAssignment(participants, controllers)) {
      // Wait until every expected pair is reflected at both clients.
      goTo("results");
    }

    if (phaseRef.current === "progress") {
      if (matchedRef.current ||
          modelRef.current.state === "loading" ||
          participants.length === 0)
        return;
      const allAnswered = participants.every(
        (p) => answersOf(controllers, p.id)
      );
      if (!allAnswered)
        return;
      const remotes = participants.filter(
        (p) => p.role === "remote");
      const buddies = participants.filter(
        (p) => p.role === "buddyDevice");
      if (remotes.length === 0 || buddies.length === 0)
        return;
      const elected = electController(controllers);
      if (!elected ||
          elected.id !== snap.selfId)
        return;
      matchedRef.current = true;
      goTo("matching");
      applyMatching(snap);
      return;
    }

    // results: annotate the pairs with match percentages once the
    // model is available
    if (!localResultRef.current &&
        modelRef.current.state !== "loading") {
      localResultRef.current = computeMatching(snap);
      setLocalResult(localResultRef.current);
    }
  }, []);

  // Connect as the assignment controller of the participant named in
  // the URL, and download the matching model in the background.
  useEffect(() => {
    if (!locRef.current)
      return;

    const conn = new ControllerConnection(locRef.current);
    connRef.current = conn;
    conn.onJoined = () => {
      if (phaseRef.current === "connecting" ||
          phaseRef.current === "login")
        goTo("form");
    };
    conn.onJoinFailed = (error, message) => {
      if (error === "redirect") {
        window.location.href = message;
        return;
      }
      setLoginError(
        message || "Please log in to join the meeting."
      );
      goTo("login");
    };
    conn.onUsersChange = (snap) => {
      setSnapshot(snap);
      handleUsers(snap);
    };
    conn.onDisconnect = () =>
      setConnError("Disconnected from the server. Reload the page.");
    conn.onSocketError = (e) =>
      setConnError(e?.message || String(e));
    conn.connect();

    (async () => {
      try {
        const spell = await loadSpellChecker(
          import.meta.env.BASE_URL);
        const embeddings = await loadGloveFromUrl(
          GLOVE_MODEL_PATH);
        modelRef.current = { state: "ready", embeddings, spell };
        setModelState("ready");
      } catch (err) {
        console.error("Could not load the matching model:", err);
        modelRef.current = {
          state: "failed", embeddings: null, spell: null,
        };
        setModelState("failed");
      }
      // the model arriving may unblock the matching
      if (snapshotRef.current)
        handleUsers(snapshotRef.current);
    })();

    return () => conn.close();
  }, [handleUsers]);

  function handleSubmit(e) {
    e.preventDefault();
    connRef.current?.submitAnswers(
      Object.fromEntries(
        questionsRef.current.map((q) => [q.id, q.answer.trim()])
      )
    );
    goTo("progress");
  }

  function handleLogin(e) {
    e.preventDefault();
    setLoginError(null);
    setConnError(null);
    goTo("connecting");
    connRef.current?.rejoin(
      username.trim() || null,
      password || null
    );
  }

  function handleMatchNow() {
    const snap = snapshotRef.current;
    if (!snap || matchedRef.current)
      return;
    const result = computeMatching(snap);
    if (result.pairs.length === 0)
      return;
    matchedRef.current = true;
    goTo("matching");
    applyMatching(snap);
  }

  function renderBadUrl() {
    return (
      <section className="main-section">
        <header className="app-header">
          <h1>Buddy assignment</h1>
          <p className="subtitle">
            This page assigns buddies in a meeting.  Open it through the
            link that the meeting gave you (it looks like
            {" "}<code>/assignment/&lt;group&gt;/&lt;id&gt;?role=…</code>).
          </p>
        </header>
      </section>
    );
  }

  function renderLogin() {
    return (
      <section className="main-section">
        <header className="app-header">
          <h1>Join the meeting</h1>
          <p className="subtitle">
            The meeting requires you to log in before you can be matched
            with your buddy.
          </p>
        </header>
        <form className="login-card" onSubmit={handleLogin}>
          {loginError && <p className="error-note">{loginError}</p>}
          <label className="field">
            <span className="field-label">Username</span>
            <input
              className="field-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="field-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <div className="action-row">
            <button type="submit" className="btn btn-primary">
              Join
            </button>
          </div>
        </form>
      </section>
    );
  }

  function renderForm() {
    const currentUser = snapshot?.participants?.find(
      (p) => p.id === location?.participantId
    );
    return (
      <section className="main-section">
        <header className="app-header">
          <h1>
            Find Your Meeting Buddy
            {currentUser?.username ? ` ${currentUser.username}` : ""}
          </h1>
          <p className="subtitle">
            Answer the questions below and we'll automatically match you
            with your buddy!
          </p>
        </header>

        <section className="answers-section">
          <div className="questions-list">
            {questions.map((q, index) => (
              <div key={q.id} className="question-card">
                <h3>{`Question ${index + 1}`}</h3>
                <h4>{sampleQuestions[index] || `Question ${index + 1}`}</h4>
                <textarea
                  className="participant-answer-input"
                  rows={3}
                  value={q.answer}
                  onChange={(e) => updateAnswer(q.id, e.target.value)}
                  placeholder="Enter answer"
                />
              </div>
            ))}
          </div>

          <div className="action-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
            >
              Find Your Buddy!
            </button>
          </div>
        </section>
      </section>
    );
  }

  function renderProgress() {
    const { participants, controllers } = snapshot || {};
    const answered = (participants || []).filter((p) =>
      answersOf(controllers, p.id)
    );
    const answeredIds = new Set(answered.map((p) => p.id));
    const canMatchNow =
      modelState !== "loading" &&
      answered.some((p) => p.role === "remote") &&
      answered.some((p) => p.role === "buddyDevice");

    return (
      <section className="main-section waiting-section">
        <h2>Your answers have been submitted!</h2>
        <p>Please wait while we find your buddy.</p>

        {participants && participants.length > 0 && (
          <div className="participants-list">
            {participants.map((p) => (
              <div
                key={p.id}
                className={
                  "participant-card " +
                  (answeredIds.has(p.id) ? "answered" : "pending")
                }
              >
                <div className="participant-top">
                  <span className="participant-name">
                    {p.username || "unknown"}
                  </span>
                  <span className="role-label">
                    {ROLE_LABELS[p.role] || p.role}
                  </span>
                  <span className="answered-badge">
                    {answeredIds.has(p.id) ? "answered" : "waiting…"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="status-note">
          {modelState === "loading" &&
            "Downloading the matching model…"}
          {modelState === "failed" &&
            "The matching model could not be loaded; participants will be paired in join order."}
        </p>

        <div className="action-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!canMatchNow}
            onClick={handleMatchNow}
            title="Match the participants that have already answered"
          >
            Match with those who answered
          </button>
        </div>
      </section>
    );
  }

  function renderMatching() {
    return (
      <section className="main-section waiting-section">
        <h2>Computing the buddy assignment…</h2>
        <div className="spinner" aria-label="matching" />
      </section>
    );
  }

  function renderApplying() {
    return (
      <section className="main-section waiting-section">
        <h2>Applying the buddy assignment…</h2>
        <p>Waiting for both participants to receive their match.</p>
        <div className="spinner" aria-label="applying assignment" />
      </section>
    );
  }

  function renderResults() {
    const { participants, controllers } = snapshot || {};
    const myParticipant =
      participants?.find((p) => p.id === location?.participantId);
    const myBuddy = myParticipant?.assignedTo
      ? participants?.find((p) => p.id === myParticipant.assignedTo)
      : null;

    const pairs = (participants || [])
      .filter((p) =>
        p.role === "remote" && p.assignedTo &&
        (p.id === location?.participantId ||
         p.assignedTo === location?.participantId)
      )
      .map((p) => {
        const buddy = participants.find(
          (b) => b.id === p.assignedTo
        );
        const remoteAnswers = answersOf(controllers || [], p.id) || {};
        const buddyAnswers = answersOf(controllers || [], p.assignedTo) || {};
        return {
          id: p.id,
          remoteName: p.username,
          buddyName: buddy?.username || "unknown",
          answers: Object.keys(remoteAnswers)
            .sort((a, b) => Number(a) - Number(b))
            .map((questionId) => ({
              questionId,
              remote: remoteAnswers[questionId],
              buddy: buddyAnswers[questionId] ?? "",
            })),
        };
      });
    return (
      <section className="main-section results-section">
        <header className="app-header">
          <h1>Buddy assignments</h1>
        </header>

        {myParticipant && (
          <div className="buddy-callout">
            {myBuddy
              ? `You are matched with ${myBuddy.username || "unknown"}!`
              : "You could not be matched (yet)."}
            <div className="callout-hint">
              Return to the meeting tab to continue; your view has
              already switched there.
            </div>
          </div>
        )}

        <div className="assigned-pairs-card">
          <h3>Your buddy pair</h3>
          <div className="pairs-list">
            {pairs.map((pair) => (
              <div key={pair.id} className="pair-pill">
                <h4>
                  <strong>{pair.remoteName}</strong>
                  {" \u2194 "}
                  <strong>{pair.buddyName}</strong>
                </h4>
                <table className="answers-table">
                  <thead><tr><th>Question</th><th>{pair.remoteName}</th><th>{pair.buddyName}</th></tr></thead>
                  <tbody>
                    {pair.answers.map((answer, index) => (
                      <tr key={answer.questionId}>
                        <th>{sampleQuestions[index] || `Question ${answer.questionId}`}</th>
                        <td>{answer.remote}</td>
                        <td>{answer.buddy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {pairs.length === 0 && (
              <p className="unmatched-note">
                No matched pair to show.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="app-container">
      {connError && <p className="error-note">{connError}</p>}
      {phase === "badUrl" && renderBadUrl()}
      {phase === "connecting" && (
        <section className="main-section waiting-section">
          <h2>Connecting…</h2>
          <div className="spinner" aria-label="connecting" />
        </section>
      )}
      {phase === "login" && renderLogin()}
      {phase === "form" && renderForm()}
      {phase === "progress" && renderProgress()}
      {phase === "matching" && renderMatching()}
      {phase === "applying" && renderApplying()}
      {phase === "results" && renderResults()}
    </div>
  );
}

export default App;
