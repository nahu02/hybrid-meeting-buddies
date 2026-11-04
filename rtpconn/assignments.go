package rtpconn

import (
	"net/url"

	"github.com/jech/galene/group"
)

// assignmentControllerURL is the base URL of the external assignment
// controller (the thing that runs the minigames).  Hardcoded for now.
const assignmentControllerURL = "https://example.com"

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

// assignmentURL builds <base>/<groupName>/<participantId>?role=<role>.
//
// We use net/url instead of string concatenation so that group names
// and ids are escaped correctly.
func assignmentURL(groupName, participantId, role string) string {
	// url.Parse returns (*url.URL, error); the base is a constant so the
	// error can't happen, and we discard it with the blank identifier.
	u, _ := url.Parse(assignmentControllerURL)
	u = u.JoinPath(groupName, participantId)
	u.RawQuery = url.Values{"role": {role}}.Encode()
	return u.String()
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
		err := wc.OpenURL(assignmentURL(g.Name(), wc.Id(), role))
		if err != nil {
			// Typically ErrClientDead: the client is going away.
			continue
		}
	}
}
