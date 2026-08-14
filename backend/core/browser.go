package core

import (
	"log"
	"os/exec"
	"runtime"
)

func OpenBrowser(targetURL string) {
	command, arguments := browserLaunchCommand(targetURL)
	if err := exec.Command(command, arguments...).Start(); err != nil {
		log.Printf("[browser] open %q: %v", targetURL, err)
	}
}

func browserLaunchCommand(targetURL string) (string, []string) {
	switch runtime.GOOS {
	case "windows":
		return "cmd", []string{"/c", "start", targetURL}
	case "darwin":
		return "open", []string{targetURL}
	default:
		return "xdg-open", []string{targetURL}
	}
}
