package rtpconn

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestBuddyPairJSON(t *testing.T) {
	var pairs []BuddyPair
	err := json.Unmarshal(
		[]byte(`[{"remote":"r1","buddyDevice":"b1"},{"remote":"r2","buddyDevice":"b2"}]`),
		&pairs,
	)
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	want := []BuddyPair{{"r1", "b1"}, {"r2", "b2"}}
	if !reflect.DeepEqual(pairs, want) {
		t.Errorf("got %v, expected %v", pairs, want)
	}
}

func TestValidateBuddyPairs(t *testing.T) {
	clients := map[string]string{
		"r1": "remote", "r2": "remote",
		"b1": "buddyDevice", "b2": "buddyDevice",
		"l": "leader",
	}
	lookup := func(id string) (bool, string) {
		role, ok := clients[id]
		return ok, role
	}

	good := []struct {
		name  string
		pairs []BuddyPair
	}{
		{"two pairs", []BuddyPair{{"r1", "b1"}, {"r2", "b2"}}},
		{"empty list clears everything", []BuddyPair{}},
		{"nil list clears everything", nil},
	}
	for _, v := range good {
		err := validateBuddyPairs(v.pairs, lookup)
		if err != nil {
			t.Errorf("%v: %v", v.name, err)
		}
	}

	bad := []struct {
		name  string
		pairs []BuddyPair
	}{
		{"unknown remote", []BuddyPair{{"nope", "b1"}}},
		{"unknown buddyDevice", []BuddyPair{{"r1", "nope"}}},
		{"empty remote", []BuddyPair{{"", "b1"}}},
		{"empty buddyDevice", []BuddyPair{{"r1", ""}}},
		{"remote equals buddyDevice", []BuddyPair{{"r1", "r1"}}},
		{"remote in buddyDevice slot", []BuddyPair{{"r1", "r2"}}},
		{"buddyDevice in remote slot", []BuddyPair{{"b1", "r1"}}},
		{"leader as remote", []BuddyPair{{"l", "b1"}}},
		{"duplicate across pairs",
			[]BuddyPair{{"r1", "b1"}, {"r1", "b2"}}},
		{"duplicate buddyDevice across pairs",
			[]BuddyPair{{"r1", "b1"}, {"r2", "b1"}}},
	}
	for _, v := range bad {
		err := validateBuddyPairs(v.pairs, lookup)
		if err == nil {
			t.Errorf("%v: no error", v.name)
		}
	}
}
