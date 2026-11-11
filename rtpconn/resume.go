package rtpconn

import (
	crand "crypto/rand"
	"encoding/base64"
	"slices"
	"sync"
	"time"

	"github.com/jech/galene/group"
)

const resumeLifetime = 24 * time.Hour

type resumeSession struct {
	key, group, username, role, currentClientId string
	permissions                                 []string
	data                                        map[string]interface{}
	partnerKey, partnerId                       string
	expires                                     time.Time
}

var resumeSessions = struct {
	sync.Mutex
	byToken map[string]string
	byKey   map[string]*resumeSession
}{byToken: make(map[string]string), byKey: make(map[string]*resumeSession)}

func randomResumeValue() string {
	value := make([]byte, 32)
	if _, err := crand.Read(value); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(value)
}

func cloneResumeSession(s *resumeSession) *resumeSession {
	if s == nil {
		return nil
	}
	data := make(map[string]interface{}, len(s.data))
	for k, v := range s.data {
		data[k] = v
	}
	return &resumeSession{
		key: s.key, group: s.group, username: s.username, role: s.role,
		currentClientId: s.currentClientId,
		permissions:     slices.Clone(s.permissions), data: data,
		partnerKey: s.partnerKey, partnerId: s.partnerId, expires: s.expires,
	}
}

// takeResumeSession consumes a valid ticket. Tickets are capabilities scoped
// to one group and one in-memory session, and expire after one day.
func takeResumeSession(ticket, groupName string) (*resumeSession, bool) {
	if ticket == "" {
		return nil, false
	}
	resumeSessions.Lock()
	defer resumeSessions.Unlock()
	now := time.Now()
	for key, s := range resumeSessions.byKey {
		if now.After(s.expires) {
			delete(resumeSessions.byToken, sToken(s))
			if partner := resumeSessions.byKey[s.partnerKey]; partner != nil {
				partner.partnerKey = ""
				partner.partnerId = ""
				if partner.data != nil {
					delete(partner.data, "assignedTo")
				}
			}
			delete(resumeSessions.byKey, key)
		}
	}
	key, ok := resumeSessions.byToken[ticket]
	if !ok {
		return nil, false
	}
	s := resumeSessions.byKey[key]
	if s == nil || s.group != groupName || now.After(s.expires) {
		delete(resumeSessions.byToken, ticket)
		return nil, false
	}
	delete(resumeSessions.byToken, ticket)
	return cloneResumeSession(s), true
}

// sToken finds the current ticket for a session. The reverse mapping is
// deliberately kept only in memory; the client stores the ticket in tab
// session storage and receives a fresh one after every successful resume.
func sToken(s *resumeSession) string {
	for token, key := range resumeSessions.byToken {
		if key == s.key {
			return token
		}
	}
	return ""
}

func initializeResumeSession(c *webClient, previous *resumeSession) string {
	role, _ := c.Data()["role"].(string)
	if role != "leader" && role != "remote" && role != "buddyDevice" {
		return ""
	}

	resumeSessions.Lock()
	defer resumeSessions.Unlock()
	var s *resumeSession
	if previous != nil {
		s = resumeSessions.byKey[previous.key]
	}
	if s == nil {
		key := randomResumeValue()
		if key == "" {
			return ""
		}
		s = &resumeSession{key: key}
		resumeSessions.byKey[key] = s
	}
	for token, key := range resumeSessions.byToken {
		if key == s.key {
			delete(resumeSessions.byToken, token)
		}
	}
	ticket := randomResumeValue()
	if ticket == "" {
		return ""
	}
	s.group = c.group.Name()
	s.username = c.Username()
	s.role = role
	s.currentClientId = c.Id()
	s.permissions = slices.Clone(c.Permissions())
	s.data = c.Data()
	s.partnerId = ""
	if assignedTo, _ := s.data["assignedTo"].(string); assignedTo != "" {
		s.partnerId = assignedTo
	}
	s.expires = time.Now().Add(resumeLifetime)
	if partner := resumeSessions.byKey[s.partnerKey]; partner != nil {
		partner.expires = s.expires
	}
	resumeSessions.byToken[ticket] = s.key
	c.resumeKey = s.key
	c.resumeToken = ticket
	return ticket
}

func updateResumePair(a, b *webClient) {
	if a == nil || b == nil || a.resumeKey == "" || b.resumeKey == "" {
		return
	}
	resumeSessions.Lock()
	defer resumeSessions.Unlock()
	ra, rb := resumeSessions.byKey[a.resumeKey], resumeSessions.byKey[b.resumeKey]
	if ra == nil || rb == nil {
		return
	}
	ra.partnerKey, ra.partnerId = rb.key, b.Id()
	rb.partnerKey, rb.partnerId = ra.key, a.Id()
	ra.expires = time.Now().Add(resumeLifetime)
	rb.expires = ra.expires
}

func clearResumePair(c *webClient) {
	if c == nil || c.resumeKey == "" {
		return
	}
	resumeSessions.Lock()
	defer resumeSessions.Unlock()
	s := resumeSessions.byKey[c.resumeKey]
	if s == nil {
		return
	}
	if partner := resumeSessions.byKey[s.partnerKey]; partner != nil {
		partner.partnerKey = ""
		partner.partnerId = ""
		if partner.data != nil {
			delete(partner.data, "assignedTo")
		}
	}
	s.partnerKey = ""
	s.partnerId = ""
	if s.data != nil {
		delete(s.data, "assignedTo")
	}
}

func restoreResumePair(g *group.Group, c *webClient, previous *resumeSession) {
	if g == nil || c == nil || previous == nil || previous.partnerKey == "" {
		return
	}
	var partner *webClient
	for _, client := range g.GetClients(nil) {
		if wc, ok := client.(*webClient); ok && wc.resumeKey == previous.partnerKey {
			partner = wc
			break
		}
	}
	if partner == nil {
		return
	}
	c.action(setDataAction{data: map[string]interface{}{"assignedTo": partner.Id()}})
	partner.action(setDataAction{data: map[string]interface{}{"assignedTo": c.Id()}})
	updateResumePair(c, partner)
}

func saveResumeSession(c *webClient) {
	if c == nil || c.resumeKey == "" || c.group == nil {
		return
	}
	resumeSessions.Lock()
	if s := resumeSessions.byKey[c.resumeKey]; s != nil &&
		s.currentClientId == c.Id() {
		s.username = c.Username()
		s.permissions = slices.Clone(c.Permissions())
		s.data = c.Data()
		s.expires = time.Now().Add(resumeLifetime)
		if partner := resumeSessions.byKey[s.partnerKey]; partner != nil {
			partner.expires = s.expires
		}
	}
	resumeSessions.Unlock()
}

func removeResumeSession(c *webClient) {
	if c == nil || c.resumeKey == "" {
		return
	}
	resumeSessions.Lock()
	s := resumeSessions.byKey[c.resumeKey]
	if s != nil && s.currentClientId == c.Id() {
		delete(resumeSessions.byKey, s.key)
		for token, key := range resumeSessions.byToken {
			if key == s.key {
				delete(resumeSessions.byToken, token)
			}
		}
		if partner := resumeSessions.byKey[s.partnerKey]; partner != nil {
			partner.partnerKey = ""
			partner.partnerId = ""
			if partner.data != nil {
				delete(partner.data, "assignedTo")
			}
		}
		if s.data != nil {
			delete(s.data, "assignedTo")
		}
	}
	resumeSessions.Unlock()
}
