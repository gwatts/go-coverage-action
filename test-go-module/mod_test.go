package testmod

import "testing"

func TestColors(t *testing.T) {
	result := returnColor("blue")
	if result != "#00f" {
		t.Fatal("incorrect result")
	}
}
