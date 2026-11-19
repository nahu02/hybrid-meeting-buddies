package rtpconn

import (
	"github.com/jech/galene/group"
)

// OpenURL asks the client's browser to offer opening u in a new tab.
//
// Privileged: the client ignores unprivileged openUrl messages, so a
// participant can't forge one through a usermessage.
func (c *webClient) OpenURL(u string) error {
	return c.write(clientMessage{
		Type:       "usermessage",
		Kind:       "openUrl",
		Privileged: true,
		Value:      u,
	})
}

// ClientInfo describes one web client of a group, as returned by
// GroupClients.
type ClientInfo struct {
	Id         string `json:"id"`
	Username   string `json:"username,omitempty"`
	Role       string `json:"role,omitempty"`
	AssignedTo string `json:"assignedTo,omitempty"`
}

// GroupClients returns the web clients of g (non-web clients such as
// the disk recorder are skipped).
func GroupClients(g *group.Group) []ClientInfo {
	// non-nil, so that an empty group is encoded as [] rather than null
	clients := make([]ClientInfo, 0)
	for _, cc := range g.GetClients(nil) {
		wc, ok := cc.(*webClient)
		if !ok {
			continue
		}
		data := wc.Data()
		role, _ := data["role"].(string)
		assignedTo, _ := data["assignedTo"].(string)
		clients = append(clients, ClientInfo{
			Id:         wc.Id(),
			Username:   wc.Username(),
			Role:       role,
			AssignedTo: assignedTo,
		})
	}
	return clients
}

// OpenURL offers the link u to the client id of g; it fails if id is
// not a web client of g.
func OpenURL(g *group.Group, id string, u string) error {
	wc, ok := g.GetClient(id).(*webClient)
	if !ok {
		return group.UserError("no such client: " + id)
	}
	return wc.OpenURL(u)
}

// BuddyPair is one assignment: the remote participant and the buddy
// device it is paired with, identified by their client ids.
type BuddyPair struct {
	Remote      string `json:"remote"`
	BuddyDevice string `json:"buddyDevice"`
}

// SetAssignment replaces all buddy pairs of g with pairs (an empty
// list clears every assignment).  The pairs are validated as a whole
// first, so an invalid request changes nothing.
func SetAssignment(g *group.Group, pairs []BuddyPair) error {
	err := validateBuddyPairs(pairs, func(id string) (bool, string) {
		wc, ok := g.GetClient(id).(*webClient)
		if !ok {
			return false, ""
		}
		role, _ := wc.Data()["role"].(string)
		return true, role
	})
	if err != nil {
		return err
	}
	assignBuddies(g, pairs)
	return nil
}

// lookupClient reports whether id names a web client, and if so its
// role.  It is passed as a function so that validateBuddyPairs can be
// tested without a live group.
type lookupClient func(id string) (webClient bool, role string)

// validateBuddyPairs checks that every id of every pair names a web
// client of the expected role, and that no client appears twice.
func validateBuddyPairs(pairs []BuddyPair, lookup lookupClient) error {
	seen := make(map[string]bool)
	check := func(id, want string) error {
		if id == "" {
			return group.UserError("empty client id in pair")
		}
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

// assignBuddies applies the final assignment state once per client, then
// reroutes the group after all client-local state has been updated. pairs
// must already be validated (validateBuddyPairs).
func assignBuddies(g *group.Group, pairs []BuddyPair) {
	assignments := make(map[string]interface{})
	for _, p := range pairs {
		assignments[p.Remote] = p.BuddyDevice
		assignments[p.BuddyDevice] = p.Remote
	}
	type pendingUpdate struct {
		client *webClient
		done   chan struct{}
	}
	pending := make([]pendingUpdate, 0)
	for _, cc := range g.GetClients(nil) {
		wc, ok := cc.(*webClient)
		if !ok {
			continue
		}
		var assignedTo interface{}
		if other, ok := assignments[wc.Id()]; ok {
			assignedTo = other
		}
		done := make(chan struct{})
		wc.action(setDataAction{
			data: map[string]interface{}{"assignedTo": assignedTo},
			done: done,
		})
		pending = append(pending, pendingUpdate{client: wc, done: done})
	}
	for _, update := range pending {
		select {
		case <-update.done:
		case <-update.client.done:
		}
	}
	// All clients now expose the final pairing state; reroute once instead
	// of negotiating every intermediate clear/apply state.
	rerouteGroup(g)
}
