package testpkg

import (
	"testing"

	testmod "test-module"
)

func TestColors(t *testing.T) {
	result := testmod.ReturnColor("red")
	if result != "#f00" {
		t.Fatal("incorrect result")
	}
	result = testmod.ReturnColor("green")
	if result != "#0f0" {
		t.Fatal("incorrect result")
	}
}
