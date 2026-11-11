# Implementation Plan: Hybrid Meeting Buddy Views

This plan implements the role-specific views of the hybrid meeting buddy
system on top of the current `clients` branch. The desired behaviour is
documented in `README.md` (section _Hybrid meeting buddies_); this file
describes how to get there.

## Baseline (already implemented)

The following is in place and must not be regressed:

- **Roles as join data** — the page query parameters except `token` are
  sent as the client's join `data` (`static/galene.js`, `start()` and
  `join()`; `ServerConnection.prototype.join` in `static/protocol.js:557`).
  The role is `leader`, `buddyDevice` or `remote`, and never changes after
  joining. It is selected on the login form, remembered in browser settings,
  and reflected in the URL; a valid `role` query parameter takes precedence.
- **Server-side stream filtering** — `filterTracksByRoles`
  (`rtpconn/webclient.go:1143`), called from `pushDownConn`, delivers only
  the streams each role is allowed to see:
    - the _leader_ never receives buddy device feeds, and stops receiving
      audio of a remote whose buddy set `audioRoute: local`;
    - a _buddy device_ receives nothing before assignment; after
      assignment only its buddy's stream (video always, audio only when
      its own `audioRoute` is `local`), never screenshares;
    - a _remote_ receives other remotes, the leader (audio and
      screenshare only, once assigned), and its own buddy device's camera
      (audio too, when the buddy's `audioRoute` is `local`).
- **Re-filtering on change** — `setData` (`rtpconn/webclient.go:150`)
  merges client data, broadcasts `user change` messages to everyone and
  calls `rerouteGroup`; a disconnect unassigns the departing client's
  buddy (`leaveGroup`, `rtpconn/webclient.go:1505`).
- **Assignment flow trigger** — the leader-only _Start assignments_
  button (`static/galene.html`, gated in `setButtonsVisibility`,
  `static/galene.js:512`) sends the `startAssignments` groupaction
  (`rtpconn/webclient.go:1857`). `startAssignments`
  (`rtpconn/assignments.go:46`) clears every client's `assignedTo` and
  sends every remote and buddy device a privileged `openUrl` usermessage
  pointing at `/assignment/<group>/<id>?role=<role>`. The client displays a
  CSP-safe tap-to-open link (`gotUserMessage`, `openUrl` case in
  `static/galene.js`), because browsers block un-gesture-initiated
  `window.open`.

Phases 1–3 implement the assignment page and transport, role selection, and
role-specific client views. Phase 4 edge cases and Phase 5 additional
verification remain.

## Phase 1 — Assignment interface page (empty for now)

_Status: implemented — `static/assignment.html`,
`assignmentHandler` in `webserver/webserver.go`, relative
`assignmentControllerURL` in `rtpconn/assignments.go`, unit tests in
`rtpconn/assignments_test.go` and `webserver/webserver_test.go`
(`TestAssignmentURL`, `TestAssignmentHandler`)._

- Add `static/assignment.html`: a minimal placeholder page. This is
  where the assignment minigames will live later.
- Add an HTTP route in `webserver/webserver.go`, mirroring
  `groupHandler` (`webserver/webserver.go:334`, which serves
  `galene.html` for every `/group/<name>/` path): any path under
  `/assignment/<group>/<id>` serves `static/assignment.html`. The
  generic `/` fileHandler (`webserver/webserver.go:208`) cannot serve
  subpaths of a page, so a dedicated handler is needed; register it
  alongside the other handlers.
- Change `assignmentControllerURL` (`rtpconn/assignments.go:13`) from
  `https://example.com` to the relative base `"/assignment"`.
  `url.Parse`/`JoinPath` already handle relative bases, and the toast's
  `destination` resolves against the page origin, so no other change is
  needed. The resulting URL is
  `/assignment/<group>/<myId>?role=<role>`, one per participant.
  (If the controller later moves off-server, make this base
  configurable; out of scope for now.)

## Phase 2 — Applying assignments (interface → server)

_Status: implemented — the React controller in `buddy-assignment-app/`
connects through `protocol.js`, collects answers, elects one controller,
computes a maximum-weight bipartite matching, and submits `assignBuddies`.
The server validates and applies the pairs. The app is built into
`static/assignment/` (ignored build output) and served by
`assignmentHandler`. App build, lint, matching tests, `go test ./...`, and the
websocket end-to-end smoke test pass; `go vet ./...` reports existing
unkeyed-composite-literal warnings._

- Controller transport: `buddy-assignment-app/src/galene.js` joins with
  `role: assignmentController`, tracks user messages, retries login, and
  submits answers and assignments over the existing protocol actions.
- Matching and app flow: `src/algorithms/matching.js` computes weighted
  remote-to-buddy pairs; `src/App.jsx` handles answer submission, progress,
  deterministic controller election, matching, and results. It waits for
  reciprocal `assignedTo` updates before displaying the final results.
- Build and serving: Vite builds under `/assignment/` into
  `static/assignment/`; the build output is gitignored. The web handler serves
  the built app when present and keeps the phase 1 placeholder as fallback.
- Smoke test: `buddy-assignment-app/test/e2e.mjs` starts a temporary Galene
  server and exercises the websocket assignment flow.

- When the minigames exist, the assignment page connects to the group
  with `protocol.js` and joins with `data: {role: 'assignmentController'}`
  (no media, requests nothing). It observes all clients and their ids
  from the `user` messages.
- Add a new groupaction `assignBuddies` with value
  `[{remote: <id>, buddyDevice: <id>}, ...]`, handled in
  `handleClientMessage` next to `startAssignments`
  (`rtpconn/webclient.go:1857`):
    - validate that the sender has role `assignmentController` (or the
      `op` permission);
    - validate that each id exists in the group and that the pair is
      really one `remote` and one `buddyDevice`;
    - queue `setDataAction{data: {assignedTo: <other id>}}` to both
      clients of every pair, exactly as `startAssignments` does
      (`rtpconn/assignments.go:46`). `setData` then broadcasts the
      changes and re-runs the track filtering, so the original tabs
      update their views automatically.
- **Protocol constraint:** the only client-side divergence from the
  Galene protocol remains the `data` field (set at `join`, later modified
  via the `setdata` useraction). `startAssignments`, `openUrl` and
  `assignBuddies` are server-side extensions, consistent with the
  existing commit.
- **Interim testing without the minigames:** self-setdata is already
  permitted (`rtpconn/webclient.go:2157`), so an assignment can be
  simulated from the browser console on both sides:
    ```javascript
    serverConnection.userAction('setdata', serverConnection.id, {
        assignedTo: '<id of the buddy/remote>',
    });
    ```

## Phase 3 — Role-aware client UI

_Status: implemented — role selection and persistence, joined-role UI
tracking, leader and buddy-device views, auto-present, audio routing, and
camera flipping are implemented in `static/galene.html`, `static/galene.js`,
`static/settings.js`, `static/galene.css`, and `rtpconn/webclient.go`._

### 3.0 Role selection (login dropdown)

- `static/galene.html`: add a _Role_ dropdown to the login form
  (`#loginform`), `id="roleselect"`, with the options _remote
  participant_ (default), _buddy device_ and _leader_ (the room TV).
  The role is required, so one option is always selected.
- `static/galene.js`:
    - on `join()` (`static/galene.js:324`), send the selected role as
      join data: `{...queryData, role: roleselect.value}`;
    - when the page is opened with `?role=...`, preselect the dropdown
      accordingly (invalid values fall back to the default);
    - on change, reflect the choice into the page URL with
      `history.replaceState` (`?role=<choice>`), so reloading or sharing
      the link keeps the role — the dropdown translates into a query;
    - persist the choice in the settings (`settings.js`), preselected
      unless the query parameter overrides it.
- After joining, the authoritative role is our own user data
  (`serverConnection.users[serverConnection.id].data.role`), not the
  URL or the form. Replace the `queryData.role === 'leader'` check in
  `setButtonsVisibility` (`static/galene.js:512`) with the joined
  role, which is also what the server checks
  (`rtpconn/webclient.go:1857`).

### 3.1 Role tracking

- Add `updateRoleClasses()` to `static/galene.js`: read
  `serverConnection.users[serverConnection.id].data` and set on
  `<body>` the classes `role-leader` / `role-buddyDevice` / `role-remote`
  plus `assigned` / `unassigned` (from `assignedTo`).
- Call it from `gotJoined` (`static/galene.js:2350`) after joining, and
  from `gotUser` (`static/galene.js:2257`) whenever the changed id is
  our own (data changes arrive as `user change` messages,
  `static/protocol.js:476`).

### 3.2 Leader view

- **Before assignment:** the default grid already works on desktop and
  mobile (`resizePeers`, `static/galene.js:1949`); buddy feeds never
  arrive (server-filtered).
- **After assignment:** the leader continues to see their own feed and
  all remote participants' camera feeds. Buddy device feeds remain hidden.
  Audio follows the existing routing rules (remote voices play on the TV
  unless their buddy set `audioRoute: local`), while camera video stays
  available to the leader.
- Auto-present camera and microphone on join for meeting roles when
  presentation permission is granted and the participant has not explicitly
  selected microphone-only. This ensures buddy devices can receive the
  assigned remote participant's camera stream.

### 3.3 Buddy device view

- **Unassigned:** the server sends no streams, so the grid is empty;
  CSS (`body.role-buddyDevice.unassigned`) hides the video chrome and
  shows a "waiting for assignment" hint. Auto-present camera and mic
  on join when the joined role is `buddyDevice`, since its paired remote
  must be able to receive the room camera.
- **Assigned** (`body.role-buddyDevice.assigned`): - the down stream whose `source` equals our `assignedTo`
  (`Stream.source` is set from the offer, `static/protocol.js:915`)
  becomes the full-screen main view (class `peer-fullscreen` on its
  `#peer-<localId>` div); all other peer divs are hidden; - our own up stream (`findUpMedia('camera')`) is restyled as a small
  self-preview (class `peer-pip`, absolutely positioned); - two new buttons in the top nav of `static/galene.html`, visibility
  gated in `setButtonsVisibility` (`static/galene.js:512`) to
  `role-buddyDevice && assigned`: - _Audio route_ toggle: sends
  `serverConnection.userAction('setdata', serverConnection.id,
{audioRoute: 'leader'|'local'})` and flips its label to show the
  current route (e.g. "Audio: TV" / "Audio: phone"); - _Flip camera_: re-acquires the camera with
  `facingMode: 'user'|'environment'` and replaces the up stream
  through the existing `replaceCameraStream()` path
  (`static/galene.js:1261`); extend the video constraints in
  `addLocalMedia` (`static/galene.js:1276`) to accept `facingMode`
  alongside `deviceId`, mirror only the front camera, and keep the
  choice in settings. The PIP preview follows automatically since
  it is the same up stream. - `static/galene.css` implements `peer-fullscreen`, `peer-pip` and
  the unassigned hint, mobile-first (the buddy device is a phone).

### 3.4 Remote view

- Remote participants keep the leader's camera and other remote camera
  feeds after assignment. The paired buddy camera is also visible; only
  the buddy's audio follows the `audioRoute` setting. The buddy device's
  camera arrives as a labeled feed (`setLabel` shows the buddy's username).

## Phase 4 — Edge cases

- Single-leader enforcement is implemented in `group.AddClient`: a second
  leader is refused while the current leader is in the meeting, and a new
  leader can join after that client leaves.
- Assignment redirects use short-lived, one-use handoffs scoped to the
  group and participant, so the assignment controller does not prompt for
  the participant's meeting credentials again.
- Assigned remotes retain the leader, other remote participants, and paired
  buddy device camera feeds while audio follows `audioRoute`.
- Video labels identify the leader and remote participant's own preview.
- Assignment results show each matched pair's answers side by side instead
  of displaying a score.
- Disconnect-unassignment and `audioRoute` re-routing already work.
- Screenshares from buddy devices are already dropped; screenshares
  from remotes follow the existing rules (fixed in commit `48fa254`).

## Phase 5 — Tests and verification

- Go: `go test ./...`; add unit tests (extend
  `rtpconn/webclient_test.go`) for `assignmentURL` (relative base,
  escaping), `assignBuddies` validation (bad roles, unknown ids), the
  leader-gating of `startAssignments`, and role-based camera visibility in
  `filterTracksByRoles` for leaders, remotes and buddy devices.
- JS: typecheck with `static/tsconfig.json` (`npx tsc`) where
  available; at minimum a syntax check.
- Manual end-to-end matrix: leader (desktop) + 2 remotes + buddy device
  (mobile emulation, front/back camera), all roles picked from the
  login dropdown:
    1. pre-assignment views match the README tables;
    2. _Start assignments_ → toast → new tab with the empty assignment
       page;
    3. simulate/apply an assignment (console setdata or `assignBuddies`);
    4. post-assignment views match the README tables, in the original
       tabs, without reload (the leader's grid reduces to their own
       camera tile);
    5. audio route toggle in both directions, camera flip, disconnect of
       a buddy or remote unassigns both.

## Suggested order

1. Phase 1 (page, route, URL base),
2. Phase 2 (controller, matching and server assignment transport),
3. Phase 3 (role-aware views),
4. Phase 4 (edge cases),
5. Phase 5 (tests) throughout.
