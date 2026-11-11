package rtpconn

import (
	crand "crypto/rand"
	"encoding/base64"
	"net/url"
	"sync"
	"time"

	"github.com/jech/galene/group"
)

// assignmentControllerURL is the base of the assignment controller, the
// page that runs the minigames.  It is served by our own web server
// (see webserver.assignmentHandler); the URL is relative, so it resolves
// against the origin of the server that sent the openUrl message.
const assignmentControllerURL = "/assignment"

// OpenURL asks the client's browser to offer opening u in a new tab, by
// sending it a usermessage of kind "openUrl".
//
// Privileged is set to true because the *server* is the originator: the
// client JS ignores "openUrl" messages that aren't privileged, so that
// a normal participant can't make a client open arbitrary links by
// sending a forged usermessage (see the "usermessage" case in
// handleClientMessage, which forwards messages and sets Privileged only
// for ops).
func (c *webClient) OpenURL(u string) error {
	return c.write(clientMessage{
		Type:       "usermessage",
		Kind:       "openUrl",
		Privileged: true,
		Value:      u,
	})
}

// assignmentURL builds <base>/<groupName>/<participantId>?role=<role>&ticket=...
//
// We use net/url instead of string concatenation so that group names
// and ids are escaped correctly.
func assignmentURL(groupName, participantId, role, ticket string) string {
	// url.Parse returns (*url.URL, error); the base is a constant so the
	// error can't happen, and we discard it with the blank identifier.
	u, _ := url.Parse(assignmentControllerURL)
	u = u.JoinPath(groupName, participantId)
	u.RawQuery = url.Values{"role": {role}, "ticket": {ticket}}.Encode()
	return u.String()
}

type assignmentHandoff struct {
	group, participantId, role, username string
	expires                              time.Time
}

var assignmentHandoffs = struct {
	sync.Mutex
	tickets map[string]assignmentHandoff
}{tickets: make(map[string]assignmentHandoff)}

// newAssignmentHandoff creates a one-time credential that lets the
// assignment page join as a controller without asking for the meeting
// password again. It conveys no Galene permissions and is bound to this
// group and participant.
func newAssignmentHandoff(g *group.Group, wc *webClient, role string) string {
	raw := make([]byte, 24)
	if _, err := crand.Read(raw); err != nil {
		return ""
	}
	ticket := base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now()
	assignmentHandoffs.Lock()
	for key, value := range assignmentHandoffs.tickets {
		if now.After(value.expires) {
			delete(assignmentHandoffs.tickets, key)
		}
	}
	assignmentHandoffs.tickets[ticket] = assignmentHandoff{
		group: g.Name(), participantId: wc.Id(), role: role,
		username: wc.Username(), expires: now.Add(5 * time.Minute),
	}
	assignmentHandoffs.Unlock()
	return ticket
}

// consumeAssignmentHandoff validates and consumes a one-time controller
// credential supplied in the assignment app's join data.
func consumeAssignmentHandoff(ticket, groupName, participantId, role string) (string, bool) {
	assignmentHandoffs.Lock()
	defer assignmentHandoffs.Unlock()
	handoff, ok := assignmentHandoffs.tickets[ticket]
	if !ok {
		return "", false
	}
	delete(assignmentHandoffs.tickets, ticket)
	if time.Now().After(handoff.expires) || handoff.group != groupName ||
		handoff.participantId != participantId || handoff.role != role {
		return "", false
	}
	return handoff.username, handoff.username != ""
}

// startAssignments resets all assignments in g and tells every remote and
// buddy client where to go to be assigned.
func startAssignments(g *group.Group) {
	for _, cc := range g.GetClients(nil) {
		// g.GetClients returns the group.Client interface.  A type
		// assertion (value.(T)) checks whether the concrete type is
		// *webClient; with the two-value form it reports failure in
		// ok instead of panicking.  Non-web clients (e.g. the disk
		// recorder) are skipped.
		wc, ok := cc.(*webClient)
		if !ok {
			continue
		}

		// setData must run on the client's own goroutine, so we don't
		// call it directly: we queue an action instead.  A nil value
		// means "delete this key" (see setData).  setData then
		// re-runs rerouteGroup, so track filtering updates by itself.
		wc.action(setDataAction{
			data: map[string]interface{}{"assignedTo": nil},
		})

		// A missing key or wrong type gives role == "" (the
		// "comma ok" idiom with the blank identifier).
		role, _ := wc.Data()["role"].(string)
		if role != "remote" && role != "buddyDevice" {
			continue
		}
		ticket := newAssignmentHandoff(g, wc, role)
		if ticket == "" {
			continue
		}
		err := wc.OpenURL(assignmentURL(g.Name(), wc.Id(), role, ticket))
		if err != nil {
			// Typically ErrClientDead: the client is going away.
			continue
		}
	}
}

// buddyPair is one assignment: the remote participant and the buddy
// device it is paired with, identified by their client ids.
type buddyPair struct {
	Remote      string
	BuddyDevice string
}

// parseBuddyPairs parses the value of an "assignBuddies" group action:
// a non-empty array of {remote: <id>, buddyDevice: <id>} objects.  It
// only checks the shape; whether the ids exist and really name one
// remote and one buddy device is checked by validateBuddyPairs.
func parseBuddyPairs(value interface{}) ([]buddyPair, error) {
	list, ok := value.([]interface{})
	if !ok || len(list) == 0 {
		return nil, group.UserError("bad value in assignBuddies")
	}
	pairs := make([]buddyPair, 0, len(list))
	for _, v := range list {
		pair, ok := v.(map[string]interface{})
		if !ok {
			return nil, group.UserError("bad pair in assignBuddies")
		}
		remote, _ := pair["remote"].(string)
		buddyDevice, _ := pair["buddyDevice"].(string)
		if remote == "" || buddyDevice == "" || remote == buddyDevice {
			return nil, group.UserError("bad pair in assignBuddies")
		}
		pairs = append(pairs, buddyPair{
			Remote:      remote,
			BuddyDevice: buddyDevice,
		})
	}
	return pairs, nil
}

// lookupClient reports whether id names a web client, and if so its
// role.  It is passed as a function so that validateBuddyPairs can be
// tested without a live group.
type lookupClient func(id string) (webClient bool, role string)

// validateBuddyPairs checks that every id of every pair names a web
// client of the expected role, and that no client appears twice.
func validateBuddyPairs(pairs []buddyPair, lookup lookupClient) error {
	seen := make(map[string]bool)
	check := func(id, want string) error {
		if seen[id] {
			return group.UserError(
				"client appears in multiple pairs: " + id,
			)
		}
		seen[id] = true
		isWeb, role := lookup(id)
		if !isWeb {
			return group.UserError("no such client: " + id)
		}
		if role != want {
			return group.UserError(
				"client " + id + " is not a " + want,
			)
		}
		return nil
	}
	for _, p := range pairs {
		err := check(p.Remote, "remote")
		if err != nil {
			return err
		}
		err = check(p.BuddyDevice, "buddyDevice")
		if err != nil {
			return err
		}
	}
	return nil
}

// assignBuddies replaces the assignment state of g: first every
// client's assignedTo is cleared (exactly as startAssignments does), so
// that clients not in any pair don't keep a stale assignment; then both
// members of every pair are assigned to each other.  pairs must have
// been validated with validateBuddyPairs beforehand.  setData
// broadcasts the changes and re-runs the track filtering, so the
// meeting tabs update their views without a reload.
func assignBuddies(g *group.Group, pairs []buddyPair) {
	for _, cc := range g.GetClients(nil) {
		wc, ok := cc.(*webClient)
		if !ok {
			continue
		}
		wc.action(setDataAction{
			data: map[string]interface{}{"assignedTo": nil},
		})
	}

	apply := func(id, other string) {
		cc := g.GetClient(id)
		if cc == nil {
			// The client left between validation and now; its
			// former buddy has already been cleared above, and
			// leaveGroup unassigns in the other direction.
			return
		}
		wc, ok := cc.(*webClient)
		if !ok {
			return
		}
		wc.action(setDataAction{
			data: map[string]interface{}{"assignedTo": other},
		})
	}
	for _, p := range pairs {
		apply(p.Remote, p.BuddyDevice)
		apply(p.BuddyDevice, p.Remote)
	}
}
