package testmod

func ReturnColor(code string) string {
	switch code {
	case "red":
		return "#f00"
	case "blue":
		return "#00f"
	case "green":
		return "#0f0"
	default:
		panic("invalid color")
	}
}
