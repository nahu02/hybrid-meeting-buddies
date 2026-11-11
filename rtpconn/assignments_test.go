package rtpconn

import (
	"reflect"
	"testing"
)

func TestAssignmentURL(t *testing.T) {
	a := []struct{ group, id, role, result string }{
		{"test", "abc", "remote",
			"/assignment/test/abc?role=remote&ticket=handoff"},
		{"test", "abc", "buddyDevice",
			"/assignment/test/abc?role=buddyDevice&ticket=handoff"},
		{"night watch", "abc", "remote",
			"/assignment/night%20watch/abc?role=remote&ticket=handoff"},
		{"test", "a b", "remote",
			"/assignment/test/a%20b?role=remote&ticket=handoff"},
		{"test", "a?b", "remote",
			"/assignment/test/a%3Fb?role=remote&ticket=handoff"},
		{"test", "a/b", "remote",
			"/assignment/test/a/b?role=remote&ticket=handoff"},
	}

	for _, v := range a {
		got := assignmentURL(v.group, v.id, v.role, "handoff")
		if got != v.result {
			t.Errorf("assignmentURL(%q, %q, %q): got %v, expected %v",
				v.group, v.id, v.role, got, v.result)
		}
	}
}

func TestParseBuddyPairs(t *testing.T) {
	pair := func(remote, buddy string) map[string]interface{} {
		return map[string]interface{}{
			"remote":      remote,
			"buddyDevice": buddy,
		}
	}

	pairs, err := parseBuddyPairs([]interface{}{
		pair("r1", "b1"), pair("r2", "b2"),
	})
	if err != nil {
		t.Fatalf("parseBuddyPairs: %v", err)
	}
	want := []buddyPair{{"r1", "b1"}, {"r2", "b2"}}
	if !reflect.DeepEqual(pairs, want) {
		t.Errorf("got %v, expected %v", pairs, want)
	}

	bad := []struct {
		name  string
		value interface{}
	}{
		{"not an array", map[string]interface{}{"remote": "r"}},
		{"empty array", []interface{}{}},
		{"element not an object", []interface{}{"r1"}},
		{"missing remote", []interface{}{
			map[string]interface{}{"buddyDevice": "b1"}}},
		{"missing buddyDevice", []interface{}{
			map[string]interface{}{"remote": "r1"}}},
		{"empty remote", []interface{}{pair("", "b1")}},
		{"empty buddyDevice", []interface{}{pair("r1", "")}},
		{"non-string ids", []interface{}{
			map[string]interface{}{
				"remote":      42,
				"buddyDevice": "b1",
			}}},
		{"remote equals buddyDevice", []interface{}{pair("x", "x")}},
	}
	for _, v := range bad {
		pairs, err := parseBuddyPairs(v.value)
		if err == nil {
			t.Errorf("%v: no error", v.name)
		}
		if pairs != nil {
			t.Errorf("%v: returned pairs", v.name)
		}
	}
}

func TestValidateBuddyPairs(t *testing.T) {
	clients := map[string]string{
		"r1": "remote", "r2": "remote",
		"b1": "buddyDevice", "b2": "buddyDevice",
		"l": "leader",
		"c": "assignmentController",
	}
	lookup := func(id string) (bool, string) {
		role, ok := clients[id]
		return ok, role
	}

	err := validateBuddyPairs(
		[]buddyPair{{"r1", "b1"}, {"r2", "b2"}}, lookup,
	)
	if err != nil {
		t.Errorf("valid pairs: %v", err)
	}

	bad := []struct {
		name  string
		pairs []buddyPair
	}{
		{"unknown remote", []buddyPair{{"nope", "b1"}}},
		{"unknown buddyDevice", []buddyPair{{"r1", "nope"}}},
		{"remote in buddyDevice slot", []buddyPair{{"r1", "r2"}}},
		{"buddyDevice in remote slot", []buddyPair{{"b1", "r1"}}},
		{"leader as remote", []buddyPair{{"l", "b1"}}},
		{"controller as buddyDevice", []buddyPair{{"r1", "c"}}},
		{"duplicate across pairs",
			[]buddyPair{{"r1", "b1"}, {"r1", "b2"}}},
		{"duplicate buddyDevice across pairs",
			[]buddyPair{{"r1", "b1"}, {"r2", "b1"}}},
	}
	for _, v := range bad {
		err := validateBuddyPairs(v.pairs, lookup)
		if err == nil {
			t.Errorf("%v: no error", v.name)
		}
	}
}
