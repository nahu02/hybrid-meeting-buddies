package rtpconn

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/jech/galene/conn"
	"github.com/jech/galene/group"
	"github.com/jech/galene/unbounded"
)

// fakeUp is an incoming stream: the sender's client id and its label
// ("camera" or "screenshare").
type fakeUp struct {
	user, label string
}

func (u fakeUp) AddLocal(conn.Down) error { return nil }
func (u fakeUp) DelLocal(conn.Down) bool  { return false }
func (u fakeUp) Id() string               { return u.user + "-" + u.label }
func (u fakeUp) Label() string            { return u.label }
func (u fakeUp) User() (string, string)   { return u.user, u.user }

// fakeTrack implements only Kind(); the embedded nil interface makes it
// satisfy conn.UpTrack, and any other method would panic if called.
type fakeTrack struct {
	conn.UpTrack
	kind webrtc.RTPCodecType
}

func (t fakeTrack) Kind() webrtc.RTPCodecType { return t.kind }

// newFilterGroup creates a group holding one web client per entry of
// clients (client id → data).
func newFilterGroup(t *testing.T, name string, clients map[string]map[string]interface{}) map[string]*webClient {
	t.Helper()
	dir := t.TempDir()
	saved := group.Directory
	group.Directory = dir
	t.Cleanup(func() { group.Directory = saved })
	err := os.WriteFile(filepath.Join(dir, name+".json"), []byte("{}"), 0644)
	if err != nil {
		t.Fatal(err)
	}

	wcs := make(map[string]*webClient)
	var g *group.Group
	for id, data := range clients {
		wc := &webClient{
			id: id, data: data, actions: unbounded.New[any](),
		}
		g, err = group.AddClient(name, wc, group.ClientCredentials{
			Trusted: true, TrustedUsername: id,
		})
		if err != nil {
			t.Fatalf("AddClient %v: %v", id, err)
		}
		wcs[id] = wc
	}
	for _, wc := range wcs {
		wc.group = g
		t.Cleanup(func() { group.DelClient(wc) })
	}
	return wcs
}

// TestFilterTracksByRoles checks what every viewer receives from every
// sender, for both audio routes of the assigned buddy device b1.
//
// L is the leader, r1 is assigned to b1, r2 and b2 are unassigned.
// Streams have an audio and a video track; the result lists the kinds
// that survive the filtering.
func TestFilterTracksByRoles(t *testing.T) {
	cases := []struct {
		route, viewer, sender, label, want string
	}{
		// the leader (TV) shows unassigned remotes, never buddy
		// devices, and only hears assigned remotes
		{"leader", "L", "r2", "camera", "audio video"},
		{"leader", "L", "r1", "camera", "audio"},
		{"leader", "L", "r1", "screenshare", "audio video"},
		{"leader", "L", "b1", "camera", ""},
		{"leader", "L", "b2", "camera", ""},
		{"local", "L", "r1", "camera", ""},
		{"local", "L", "r1", "screenshare", "audio video"},
		{"local", "L", "r2", "camera", "audio video"},

		// an assigned buddy device shows its remote only, and plays
		// its audio only on the local route
		{"leader", "b1", "r1", "camera", "video"},
		{"local", "b1", "r1", "camera", "audio video"},
		{"leader", "b1", "r1", "screenshare", ""},
		{"leader", "b1", "L", "camera", ""},
		{"leader", "b1", "r2", "camera", ""},
		{"leader", "b2", "r1", "camera", ""},
		{"leader", "b2", "L", "camera", ""},

		// an assigned remote sees the room through its buddy device,
		// not the leader's camera
		{"leader", "r1", "b1", "camera", "video"},
		{"local", "r1", "b1", "camera", "audio video"},
		{"leader", "r1", "L", "camera", "audio"},
		{"local", "r1", "L", "camera", ""},
		{"leader", "r1", "L", "screenshare", "audio video"},
		{"local", "r1", "L", "screenshare", "audio video"},
		{"leader", "r1", "b2", "camera", ""},
		{"leader", "r1", "r2", "camera", "audio video"},

		// an unassigned remote: everybody but the buddy devices
		{"leader", "r2", "L", "camera", "audio video"},
		{"leader", "r2", "r1", "camera", "audio video"},
		{"leader", "r2", "b1", "camera", ""},
	}

	tracks := []conn.UpTrack{
		fakeTrack{kind: webrtc.RTPCodecTypeAudio},
		fakeTrack{kind: webrtc.RTPCodecTypeVideo},
	}

	for i, tc := range cases {
		name := fmt.Sprintf("%v_from_%v_%v_%v_route", tc.viewer, tc.sender, tc.label, tc.route)
		t.Run(name, func(t *testing.T) {
			clients := newFilterGroup(t, fmt.Sprintf("filter-%v", i),
				map[string]map[string]interface{}{
					"L":  {"role": "leader"},
					"r1": {"role": "remote", "assignedTo": "b1"},
					"r2": {"role": "remote"},
					"b1": {"role": "buddyDevice", "assignedTo": "r1", "audioRoute": tc.route},
					"b2": {"role": "buddyDevice"},
				})

			got, err := filterTracksByRoles(
				fakeUp{user: tc.sender, label: tc.label},
				clients[tc.viewer], tracks,
			)
			if err != nil {
				t.Fatal(err)
			}
			kinds := []string{}
			for _, track := range got {
				kinds = append(kinds, track.Kind().String())
			}
			if strings.Join(kinds, " ") != tc.want {
				t.Errorf("got %q, expected %q",
					strings.Join(kinds, " "), tc.want)
			}
		})
	}
}
