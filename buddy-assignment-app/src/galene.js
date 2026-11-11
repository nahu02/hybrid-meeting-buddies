/**
 * Transport between the assignment app and the Galene server.
 *
 * The global ServerConnection class comes from Galene's protocol.js,
 * which index.html loads with a plain <script src="/protocol.js"> (when
 * the app is served by Galene that is static/protocol.js; during
 * development the vite dev server proxies it to the Galene server, see
 * vite.config.js).
 *
 * A controller is a client that joins the group with the role
 * "assignmentController" and no media: it observes the other clients
 * through the user messages, submits the answers of the participant
 * that opened it (identified by the participantId from its URL), and
 * (one elected controller) applies the computed buddy assignment with
 * the assignBuddies group action.
 */

export const CONTROLLER_ROLE = "assignmentController";

/**
 * Parse an assignment controller URL:
 * /assignment/<group>/<participantId>?role=<remote|buddyDevice>&ticket=...
 *
 * The group name may contain slashes, so the participant id is the
 * last path segment (mirroring how the server built the URL in
 * rtpconn/assignments.go: assignmentURL).
 *
 * @returns {{group: string, participantId: string, participantRole: string} | null}
 */
export function parseAssignmentLocation(
  pathname = window.location.pathname,
  search = window.location.search
) {
  const match = pathname.match(/^\/assignment\/(.+)\/([^/]+)\/?$/);
  if (!match) return null;
  const role = new URLSearchParams(search).get("role");
  const ticket = new URLSearchParams(search).get("ticket");
  if (role !== "remote" && role !== "buddyDevice") return null;
  return {
    group: match[1], participantId: match[2], participantRole: role,
    ticket,
  };
}

/**
 * Build a summary of the group from a ServerConnection's user list:
 * the participants (the original meeting tabs, role remote or
 * buddyDevice) and the assignment controllers (the assignment pages,
 * which carry their participant's answers in their own data). The
 * controller connections are excluded from the meeting participant UI.
 */
export function snapshotOf(sc) {
  const participants = [];
  const controllers = [];
  for (const id of Object.keys(sc.users || {})) {
    const u = sc.users[id];
    const role = u.data?.role;
    if (role === "remote" || role === "buddyDevice") {
      participants.push({
        id,
        username: u.username || "unknown",
        role,
        assignedTo: u.data?.assignedTo || null,
      });
    } else if (role === CONTROLLER_ROLE) {
      controllers.push({
        id,
        participantId: u.data?.participantId || null,
        participantRole: u.data?.participantRole || null,
        username: u.username || "unknown",
        answers: u.data?.answers || null,
      });
    }
  }
  participants.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  controllers.sort((a, b) =>
    (a.participantId || "") < (b.participantId || "") ? -1 :
    (a.participantId || "") > (b.participantId || "") ? 1 :
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  return { selfId: sc.id || null, participants, controllers };
}

/**
 * The answers of the participant that controller c speaks for,
 * or null if it hasn't submitted any (yet).
 */
export function answersOf(controllers, participantId) {
  const controller = controllers.find(
    (c) => c.participantId === participantId && c.answers
  );
  return controller?.answers || null;
}

/**
 * Elect the controller that applies the assignment: every controller
 * sees the same user list, so picking the smallest participantId and then
 * smallest controller id is deterministic, even if there are duplicate
 * controller tabs. Returns null when none has submitted answers.
 */
export function electController(controllers) {
  const candidates = controllers.filter(
    (c) => c.participantId && c.answers
  );
  if (candidates.length === 0) return null;
  return candidates[0];
}

/**
 * A controller's connection to the group: one ServerConnection that
 * joins with the controller role and never requests any streams.
 *
 * The React app sets the on* callbacks and calls connect(); everything
 * else (submitting answers, applying assignments) goes through the
 * action methods.
 */
export class ControllerConnection {
  #username = null;
  #password = null;
  #sc = null;
  #duplicateAttempt = 0;

  constructor({ group, participantId, participantRole, ticket }) {
    this.group = group;
    this.participantId = participantId;
    this.participantRole = participantRole;
    this.ticket = ticket;

    /** Called after we successfully joined the group. */
    this.onJoined = null;
    /**
     * Called when joining failed.  error is the protocol error kind
     * ('need-username', 'duplicate-username', 'redirect', or '' for
     * an authorisation failure), message the human-readable text.
     */
    this.onJoinFailed = null;
    /** Called after every change to the user list. */
    this.onUsersChange = null;
    /** Called when the connection went away. */
    this.onDisconnect = null;
    /** Called for connection-level errors. */
    this.onSocketError = null;

    this.joined = false;
  }

  /**
   * Connect and join.  username and password may be null: we join
   * anonymously first, and onJoinFailed tells the app to ask for
   * credentials (the group may require a username or a password, and
   * our participant is usually already logged in under the same
   * username in the meeting tab, which is resolved automatically
   * below).
   */
  async connect(username = null, password = null) {
    this.#username = username;
    this.#password = password;
    this.#duplicateAttempt = 0;

    let status = {};
    try {
      const r = await fetch(`/group/${this.group}/.status`);
      if (!r.ok)
        throw new Error(`${r.status} ${r.statusText}`);
      status = await r.json();
    } catch (e) {
      this.onSocketError?.(
        new Error(`Could not read group status: ${e.message}`)
      );
      return;
    }

    const endpoint = status.endpoint ||
      `ws${location.protocol === "https:" ? "s" : ""}://${location.host}/ws`;

    const sc = new ServerConnection();
    this.#sc = sc;
    sc.onconnected = () => { this.#join(); };
    sc.onjoined = (kind, group, perms, status, data, error, message) =>
      this.#gotJoined(kind, error, message);
    sc.onuser = () => { this.onUsersChange?.(this.snapshot()); };
    sc.onclose = () => {
      if (this.#sc !== sc) return;
      this.joined = false;
      this.onDisconnect?.();
    };
    sc.onerror = (e) => { this.onSocketError?.(e); };

    try {
      await sc.connect(endpoint);
    } catch (e) {
      this.onSocketError?.(e);
    }
  }

  /**
   * Join again with different credentials, e.g. after the login form
   * was shown (need-username or an authorisation failure).  Reuses the
   * still-open websocket when possible.
   */
  rejoin(username, password) {
    this.#username = username;
    this.#password = password;
    this.#duplicateAttempt = 0;
    const open = this.#sc?.socket &&
      this.#sc.socket.readyState === WebSocket.OPEN;
    if (open) {
      this.#join();
    } else {
      this.connect(username, password);
    }
  }

  /**
   * Submit our participant's answers.  They are stored on our own
   * controller client (the original meeting tab must stay untouched),
   * from where every other controller (and only those) can read them
   * through the user messages.
   *
   * @param {Record<string, string>} answers answers keyed by question id
   */
  submitAnswers(answers) {
    this.#requireSc().userAction("setdata", this.#sc.id, { answers });
  }

  /**
   * Apply a buddy assignment.
   *
   * @param {Array<{remote: string, buddyDevice: string}>} pairs
   *        client ids, as accepted by the assignBuddies group action
   */
  assignBuddies(pairs) {
    this.#requireSc().groupAction("assignBuddies", pairs);
  }

  /** The current snapshot (see snapshotOf). */
  snapshot() {
    return snapshotOf(this.#requireSc());
  }

  close() {
    this.#sc?.close();
  }

  /** Our own client id, or null before joining. */
  get id() {
    return this.#sc?.id || null;
  }

  #requireSc() {
    if (!this.#sc)
      throw new Error("not connected");
    return this.#sc;
  }

  #join() {
    this.#sc.join(
      this.group,
      this.#username ?? undefined,
      // protocol.js expects credentials to be a string or an object;
      // an empty password is simply ignored by anonymous groups.
      this.#password ?? "",
      {
        role: CONTROLLER_ROLE,
        participantId: this.participantId,
        participantRole: this.participantRole,
        assignmentTicket: this.ticket,
      }
    );
  }

  #gotJoined(kind, error, message) {
    switch (kind) {
    case "join":
    case "change":
      this.joined = true;
      this.onJoined?.();
      break;
    case "fail":
      this.joined = false;
      // The participant is usually still logged in under the same
      // username in the meeting tab; derive a fresh name and retry.
      if (error === "duplicate-username" && this.#username) {
        this.#duplicateAttempt += 1;
        if (this.#duplicateAttempt <= 5) {
          const base = this.#username.replace(/-\d+$/, "");
          this.#username = `${base}-${this.#duplicateAttempt}`;
          this.#join();
          return;
        }
      }
      this.onJoinFailed?.(error, message);
      break;
    case "leave":
      this.joined = false;
      this.onDisconnect?.();
      break;
    case "redirect":
      this.onJoinFailed?.("redirect", message);
      break;
    default:
      this.onJoinFailed?.("unknown", message);
      break;
    }
  }
}
