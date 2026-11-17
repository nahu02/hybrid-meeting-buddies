// The API of server/index.js.  BASE_URL is the Vite base, /assignment/.
const API = `${import.meta.env.BASE_URL}api`;

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: body === undefined
      ? {}
      : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let message = `${r.status} ${r.statusText}`;
    try {
      message = (await r.json()).error || message;
    } catch {
      // not JSON: keep the status line
    }
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

const enc = encodeURIComponent;

/** Everything the page shows (see RoundManager.view). */
export const getView = (round, pid) =>
  call("GET", `/rounds/${enc(round)}/participants/${enc(pid)}`);

export const submitAnswers = (round, pid, answers) =>
  call("POST", `/rounds/${enc(round)}/participants/${enc(pid)}/answers`,
    { answers });

export const matchNow = (round) =>
  call("POST", `/rounds/${enc(round)}/match`);
