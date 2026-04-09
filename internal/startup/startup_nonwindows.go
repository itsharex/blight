//go:build !windows

package startup

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func startupFilePath() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}

	switch runtime.GOOS {
	case "linux":
		return filepath.Join(home, ".config", "autostart", "blight.desktop"), true
	case "darwin":
		return filepath.Join(home, "Library", "LaunchAgents", "com.blight.launcher.plist"), true
	default:
		return "", false
	}
}

func Enable() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return err
	}

	path, ok := startupFilePath()
	if !ok {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	var content string
	if runtime.GOOS == "linux" {
		content = "[Desktop Entry]\nType=Application\nVersion=1.0\nName=blight\nExec=" + exe + "\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
	} else {
		content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.blight.launcher</string>
  <key>ProgramArguments</key>
  <array><string>` + exe + `</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>`
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

func Disable() error {
	path, ok := startupFilePath()
	if !ok {
		return nil
	}
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func IsEnabled() bool {
	path, ok := startupFilePath()
	if !ok {
		return false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(b), "blight")
}
