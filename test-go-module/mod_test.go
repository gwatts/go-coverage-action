package testmod

import "testing"

func TestColors(t *testing.T) {
	result := ReturnColor("blue")
	if result != "#00f" {
		t.Fatal("incorrect result")
	}
}
