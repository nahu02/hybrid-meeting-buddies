# Implementation Plan: Hybrid Meeting Buddy Views

This plan implements the role-specific views of the hybrid meeting buddy
system on top of the current `clients` branch.  The desired behaviour is
documented in `README.md` (section *Hybrid meeting buddies*); this file
describes how to get there.

## Baseline (already implemented)

The following is in place and must not be regressed:

- **Roles as join data** — the page query parameters except `token` are
  sent as the client's join `data` (`static/galene.js`, `start()` and
  `join()`; `ServerConnection.prototype.join` in `static/protocol.js:557`).
  The role is `leader`, `buddyDevice` or `remote`, and never changes after
  joining.  The role currently comes from the `role` query parameter;
  Phase 3.0 moves this choice to a dropdown on the login form.
- **Server-side stream filtering** — `filterTracksByRoles`
  (`rtpconn/webclient.go:1143`), called from `pushDownConn`, delivers only
  the streams each role is allowed to see:
  - the *leader* never receives buddy device feeds, and stops receiving
    audio of a remote whose buddy set `audioRoute: local`;
  - a *buddy device* receives nothing before assignment; after
    assignment only its buddy's stream (video always, audio only when
    its own `audioRoute` is `local`), never screenshares;
  - a *remote* receives other remotes, the leader (audio and
    screenshare only, once assigned), and its own buddy device's camera
    (audio too, when the buddy's `audioRoute` is `local`).
- **Re-filtering on change** — `setData` (`rtpconn/webclient.go:150`)
  merges client data, broadcasts `user change` messages to everyone and
  calls `rerouteGroup`; a disconnect unassigns the departing client's
  buddy (`leaveGroup`, `rtpconn/webclient.go:1505`).
- **Assignment flow trigger** — the leader-only *Start assignments*
  button (`static/galene.html`, gated in `setButtonsVisibility`,
  `static/galene.js:512`) sends the `startAssignments` groupaction
  (`rtpconn/webclient.go:1857`).  `startAssignments`
  (`rtpconn/assignments.go:46`) clears every client's `assignedTo` and
  sends every remote and buddy device a privileged `openUrl` usermessage
  pointing at `<assignmentControllerURL>/<group>/<id>?role=<role>`
  (currently the hardcoded placeholder `https://example.com`).  The
  client shows a tap-to-open toast (`gotUserMessage`, `openUrl` case in
  `static/galene.js`), because browsers block un-gesture-initiated
  `window.open`.

**Still missing:** (1) the assignment page itself and how it is served,
(2) the path for assignment results back to the server, (3) the
role-specific client views and their buttons — including the leader's
post-assignment view of their own feed only — and (4) choosing the
role from the login form instead of the URL.

## Phase 1 — Assignment interface page (empty for now)

- Add `static/assignment.html`: a minimal placeholder page.  This is
  where the assignment minigames will live later.
- Add an HTTP route in `webserver/webserver.go`, mirroring
  `groupHandler` (`webserver/webserver.go:334`, which serves
  `galene.html` for every `/group/<name>/` path): any path under
  `/assignment/<group>/<id>` serves `static/assignment.html`.  The
  generic `/` fileHandler (`webserver/webserver.go:208`) cannot serve
  subpaths of a page, so a dedicated handler is needed; register it
  alongside the other handlers.
- Change `assignmentControllerURL` (`rtpconn/assignments.go:13`) from
  `https://example.com` to the relative base `"/assignment"`.
  `url.Parse`/`JoinPath` already handle relative bases, and the toast's
  `destination` resolves against the page origin, so no other change is
  needed.  The resulting URL is
  `/assignment/<group>/<myId>?role=<role>`, one per participant.
  (If the controller later moves off-server, make this base
  configurable; out of scope for now.)

## Phase 2 — Applying assignments (interface → server)

- When the minigames exist, the assignment page connects to the group
  with `protocol.js` and joins with `data: {role: 'assignmentController'}`
  (no media, requests nothing).  It observes all clients and their ids
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
    (`rtpconn/assignments.go:46`).  `setData` then broadcasts the
    changes and re-runs the track filtering, so the original tabs
    update their views automatically.
- **Protocol constraint:** the only client-side divergence from the
  Galene protocol remains the `data` field (set at `join`, later modified
  via the `setdata` useraction).  `startAssignments`, `openUrl` and
  `assignBuddies` are server-side extensions, consistent with the
  existing commit.
- **Interim testing without the minigames:** self-setdata is already
  permitted (`rtpconn/webclient.go:2157`), so an assignment can be
  simulated from the browser console on both sides:
  ```javascript
  serverConnection.userAction('setdata', serverConnection.id,
                              {assignedTo: '<id of the buddy/remote>'});
  ```

## Phase 3 — Role-aware client UI

### 3.0 Role selection (login dropdown)

- `static/galene.html`: add a *Role* dropdown to the login form
  (`#loginform`), `id="roleselect"`, with the options *remote
  participant* (default), *buddy device* and *leader* (the room TV).
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
  URL or the form.  Replace the `queryData.role === 'leader'` check in
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
- **After assignment:** the leader sees only their own feed — the
  conferencing camera that captures the whole room — and no longer
  views the remote participants.  Server change in the leader branch
  of `filterTracksByRoles` (`rtpconn/webclient.go:1191`): once any
  client in the group has `assignedTo` set (an assignment has taken
  place), drop the camera video of all remote participants for the
  leader; audio keeps following the existing rules (remote voices
  play on the TV unless their buddy set `audioRoute: local`), and
  screenshare is likewise unaffected.  `startAssignments` clears every
  `assignedTo`, which restores the pre-assignment grid.  No client-side
  work is needed: the remote tiles simply stop arriving.
- Add auto-presenting of camera and microphone on join when the joined
  role is `leader` (call `addLocalMedia()` in `gotJoined`), so the
  leader sees themselves in the grid without user action — after
  assignment this camera is their entire view.

### 3.3 Buddy device view

- **Unassigned:** the server sends no streams, so the grid is empty;
  CSS (`body.role-buddyDevice.unassigned`) hides the video chrome and
  shows a "waiting for assignment" hint.  Auto-present camera and mic
  on join when the joined role is `buddyDevice`, since the buddy feed
  is mandatory.
- **Assigned** (`body.role-buddyDevice.assigned`):
  - the down stream whose `source` equals our `assignedTo`
    (`Stream.source` is set from the offer, `static/protocol.js:915`)
    becomes the full-screen main view (class `peer-fullscreen` on its
    `#peer-<localId>` div); all other peer divs are hidden;
  - our own up stream (`findUpMedia('camera')`) is restyled as a small
    self-preview (class `peer-pip`, absolutely positioned);
  - two new buttons in the top nav of `static/galene.html`, visibility
    gated in `setButtonsVisibility` (`static/galene.js:512`) to
    `role-buddyDevice && assigned`:
    - *Audio route* toggle: sends
      `serverConnection.userAction('setdata', serverConnection.id,
      {audioRoute: 'leader'|'local'})` and flips its label to show the
      current route (e.g. "Audio: TV" / "Audio: phone");
    - *Flip camera*: re-acquires the camera with
      `facingMode: 'user'|'environment'` and replaces the up stream
      through the existing `replaceCameraStream()` path
      (`static/galene.js:1261`); extend the video constraints in
      `addLocalMedia` (`static/galene.js:1276`) to accept `facingMode`
      alongside `deviceId`, mirror only the front camera, and keep the
      choice in settings.  The PIP preview follows automatically since
      it is the same up stream.
  - `static/galene.css` implements `peer-fullscreen`, `peer-pip` and
    the unassigned hint, mobile-first (the buddy device is a phone).

### 3.4 Remote view

- Default grid throughout.  After assignment the server already drops
  the leader's camera video; the resulting audio-only stream is
  auto-hidden by `showHideMedia` (`static/galene.js:1678`) unless
  *display all* is on.  The buddy device's camera arrives as a normal
  labeled feed (`setLabel` shows the buddy's username).  This phase is
  mostly verification.

## Phase 4 — Edge cases

- Single-leader enforcement: reject (or demote) a second client joining
  with `role: leader` — open design decision, decide during Phase 2.
- Disconnect-unassignment and `audioRoute` re-routing already work.
- Screenshares from buddy devices are already dropped; screenshares
  from remotes follow the existing rules (fixed in commit `48fa254`).

## Phase 5 — Tests and verification

- Go: `go test ./...`; add unit tests (extend
  `rtpconn/webclient_test.go`) for `assignmentURL` (relative base,
  escaping), `assignBuddies` validation (bad roles, unknown ids), the
  leader-gating of `startAssignments`, and the leader's
  post-assignment rule in `filterTracksByRoles` (no remote camera
  video once any `assignedTo` is set).
- JS: typecheck with `static/tsconfig.json` (`npx tsc`) where
  available; at minimum a syntax check.
- Manual end-to-end matrix: leader (desktop) + 2 remotes + buddy device
  (mobile emulation, front/back camera), all roles picked from the
  login dropdown:
  1. pre-assignment views match the README tables;
  2. *Start assignments* → toast → new tab with the empty assignment
     page;
  3. simulate/apply an assignment (console setdata or `assignBuddies`);
  4. post-assignment views match the README tables, in the original
     tabs, without reload (the leader's grid reduces to their own
     camera tile);
  5. audio route toggle in both directions, camera flip, disconnect of
     a buddy or remote unassigns both.

## Suggested order

1. Phase 1 (page, route, URL base),
2. Phase 3 (views; immediately testable via console setdata),
3. Phase 2 (grows with the minigames),
4. Phase 5 (tests) throughout.
