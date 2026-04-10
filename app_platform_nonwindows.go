//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func configureSettingsCommand(_ *exec.Cmd) {}

func blightInstallDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "blight")
}

func shellOpen(path string) {
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("open", path)
	} else {
		cmd = exec.Command("xdg-open", path)
	}
	_ = cmd.Start()
}

func explorerSelect(path string) {
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", "-R", path).Start()
		return
	}
	_ = exec.Command("xdg-open", filepath.Dir(path)).Start()
}

func runAsAdmin(path string) error {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(`do shell script "open %q" with administrator privileges`, path)
		return exec.Command("osascript", "-e", script).Start()
	default:
		if _, err := exec.LookPath("pkexec"); err == nil {
			return exec.Command("pkexec", path).Start()
		}
		return exec.Command("sudo", path).Start()
	}
}
