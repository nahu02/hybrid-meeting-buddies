package rtpconn

import "testing"

func TestAssignmentURL(t *testing.T) {
	a := []struct{ group, id, role, result string }{
		{"test", "abc", "remote",
			"/assignment/test/abc?role=remote"},
		{"test", "abc", "buddyDevice",
			"/assignment/test/abc?role=buddyDevice"},
		{"night watch", "abc", "remote",
			"/assignment/night%20watch/abc?role=remote"},
		{"test", "a b", "remote",
			"/assignment/test/a%20b?role=remote"},
		{"test", "a?b", "remote",
			"/assignment/test/a%3Fb?role=remote"},
		{"test", "a/b", "remote",
			"/assignment/test/a/b?role=remote"},
	}

	for _, v := range a {
		got := assignmentURL(v.group, v.id, v.role)
		if got != v.result {
			t.Errorf("assignmentURL(%q, %q, %q): got %v, expected %v",
				v.group, v.id, v.role, got, v.result)
		}
	}
}
