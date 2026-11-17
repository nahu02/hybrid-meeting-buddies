# Buddy assignment service

Pairs remote participants with buddy devices.  It is a small Node
server, separate from Galene:

- `server/` — the service: Express API, assignment rounds
  (`rounds.js`), the matching (`algorithms/`, GloVe word vectors and a
  spellchecker, loaded once at startup), and the client for Galene's
  API (`galene.js`).
- `src/` — the assignment page (React), which only talks to the service.

Galene forwards everything under `/assignment/` to the service
(`galene -assignment <url>`), so phones only ever talk to Galene's
address.  The service talks back to Galene through three endpoints of
Galene's API (`.clients`, `.assignment`, `.open-url`; see
`galene-api.md`).

## Flow

1. The leader presses *Start assignments* → `POST /assignment/api/rounds`.
2. The service lists the group's clients, clears the assignment, and
   sends each remote participant and buddy device a link
   `/assignment/?round=<id>&participant=<client id>`.  Starting again
   replaces the round.
3. The page polls `GET /assignment/api/rounds/<id>/participants/<client id>`
   and submits answers with `POST …/answers`.
4. Once every participant still in the meeting has answered (or someone
   presses *Match with those who answered*: `POST
   /assignment/api/rounds/<id>/match`), the service matches once and
   sends the pairs to Galene.

## Setup

Place `glove.6B.50d.txt` in `models/` (the Docker build downloads it if
it is missing).  Without it the service still runs, but pairs
participants in arbitrary order.

```sh
npm install
```

## Development

Run three processes:

```sh
# Galene (from the repository root): plain HTTP, /assignment/ → Vite
./galene -insecure -assignment http://localhost:5173

# the service (restarts on changes)
npm run dev:server

# the page, with hot reload; forwards /assignment/api to the service
npm run dev
```

Then join a group at <http://localhost:8443/group/<name>/> as a leader,
remote participants and buddy devices.

Environment variables of the service: `PORT` (3000), `GALENE_URL`
(`http://localhost:8443`), `GLOVE_PATH` (`models/glove.6B.50d.txt`).

## Production

```sh
npm run build   # the page, into dist/
npm start       # serves dist/ and the API on port 3000
./galene -assignment http://localhost:3000
```

or `docker compose up --build` from the repository root.

## Tests

```sh
npm test        # matching + round logic + end to end (needs Go and `npm run build`)
```
