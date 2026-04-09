//go:build windows

package hotkey

import (
	"blight/internal/debug"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procSetWindowsHookEx    = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx      = user32.NewProc("CallNextHookEx")
	procPeekMessage         = user32.NewProc("PeekMessageW")
	procGetAsyncKeyState    = user32.NewProc("GetAsyncKeyState")
)

const (
	WH_KEYBOARD_LL = 13
	WM_KEYDOWN     = 0x0100
	WM_KEYUP       = 0x0101
	WM_SYSKEYDOWN  = 0x0104
	WM_SYSKEYUP    = 0x0105

	// Virtual key codes
	VK_SPACE   = 0x20
	VK_MENU    = 0x12 // Alt
	VK_CONTROL = 0x11 // Ctrl
	VK_SHIFT   = 0x10 // Shift
	VK_LWIN    = 0x5B // Left Win
	VK_RWIN    = 0x5C // Right Win
	VK_TAB     = 0x09
	VK_RETURN  = 0x0D
	VK_BACK    = 0x08
	VK_DELETE  = 0x2E
	VK_ESCAPE  = 0x1B
	VK_F1      = 0x70
	VK_F12     = 0x7B
)

// HotkeyConfig holds the parsed key and modifier VK codes for a hotkey.
type HotkeyConfig struct {
	Key          uint32
	Modifiers    []uint32
	NeedsAltHook bool // true if Alt is one of the modifiers (uses WM_SYSKEYDOWN)
}

// ParseHotkey parses a string like "Alt+Space", "Ctrl+Alt+Space", "Win+Space".
// Returns a zero config (Key=0) if parsing fails.
func ParseHotkey(s string) HotkeyConfig {
	parts := strings.Split(s, "+")
	var cfg HotkeyConfig

	for _, part := range parts {
		p := strings.TrimSpace(part)
		switch strings.ToLower(p) {
		case "alt":
			cfg.Modifiers = append(cfg.Modifiers, VK_MENU)
			cfg.NeedsAltHook = true
		case "ctrl", "control":
			cfg.Modifiers = append(cfg.Modifiers, VK_CONTROL)
		case "shift":
			cfg.Modifiers = append(cfg.Modifiers, VK_SHIFT)
		case "win", "windows", "super":
			cfg.Modifiers = append(cfg.Modifiers, VK_LWIN)
		default:
			cfg.Key = parseKeyName(p)
		}
	}

	// Default to Alt+Space if parsing produced no key
	if cfg.Key == 0 {
		cfg.Key = VK_SPACE
		cfg.Modifiers = []uint32{VK_MENU}
		cfg.NeedsAltHook = true
	}

	return cfg
}

func parseKeyName(s string) uint32 {
	switch strings.ToLower(s) {
	case "space":
		return VK_SPACE
	case "tab":
		return VK_TAB
	case "enter", "return":
		return VK_RETURN
	case "backspace":
		return VK_BACK
	case "delete", "del":
		return VK_DELETE
	case "escape", "esc":
		return VK_ESCAPE
	}

	// F1–F12
	if len(s) >= 2 && (s[0] == 'f' || s[0] == 'F') {
		n := uint32(0)
		for _, c := range s[1:] {
			if c < '0' || c > '9' {
				n = 0
				break
			}
			n = n*10 + uint32(c-'0')
		}
		if n >= 1 && n <= 12 {
			return VK_F1 + n - 1
		}
	}

	// Single letter A–Z (VK code == ASCII uppercase)
	if len(s) == 1 {
		c := s[0]
		if c >= 'a' && c <= 'z' {
			return uint32(c - 32) // uppercase
		}
		if c >= 'A' && c <= 'Z' {
			return uint32(c)
		}
		if c >= '0' && c <= '9' {
			return uint32(c)
		}
	}

	return 0
}

// KBDLLHOOKSTRUCT contains info about a low-level keyboard event.
type KBDLLHOOKSTRUCT struct {
	VkCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

type MSG struct {
	HWnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

type HotkeyManager struct {
	callback   func()
	config     HotkeyConfig
	quit       chan struct{}
	hookHandle uintptr
	altPressed atomic.Bool
}

func New(hotkeyStr string, callback func()) *HotkeyManager {
	return &HotkeyManager{
		callback: callback,
		config:   ParseHotkey(hotkeyStr),
		quit:     make(chan struct{}),
	}
}

func (h *HotkeyManager) Start() error {
	go h.listen()
	return nil
}

func (h *HotkeyManager) Stop() {
	close(h.quit)
}

func (h *HotkeyManager) allModsPressed() bool {
	for _, mod := range h.config.Modifiers {
		state, _, _ := procGetAsyncKeyState.Call(uintptr(mod))
		if state&0x8000 == 0 {
			return false
		}
	}
	return true
}

func (h *HotkeyManager) listen() {
	log := debug.Get()

	// Low-level hooks MUST stay on one OS thread with an active message pump.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	log.Info("hotkey: installing keyboard hook", map[string]interface{}{
		"key":       h.config.Key,
		"modifiers": h.config.Modifiers,
	})

	hookCallback := func(nCode int, wParam uintptr, lParam uintptr) uintptr {
		if nCode >= 0 {
			kbData := (*KBDLLHOOKSTRUCT)(unsafe.Pointer(lParam))

			// Accept both KEYDOWN and SYSKEYDOWN so Alt+X combos work
			if wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN {
				if kbData.VkCode == h.config.Key && h.allModsPressed() {
					log.Info("hotkey: triggered")
					go h.callback()
					// Consume the event — prevents OS from acting on it (e.g. Alt opens menus)
					return 1
				}
			}
		}

		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	hookProc := syscall.NewCallback(hookCallback)

	hookHandle, _, hookErr := procSetWindowsHookEx.Call(
		WH_KEYBOARD_LL,
		hookProc,
		0, // hMod — 0 for global hooks
		0, // dwThreadId — 0 for all threads
	)

	if hookHandle == 0 {
		log.Error("hotkey: SetWindowsHookEx FAILED", map[string]interface{}{
			"error": hookErr.Error(),
		})
		return
	}

	h.hookHandle = hookHandle
	log.Info("hotkey: hook installed successfully")

	// Message pump — required for low-level hooks to receive events.
	var msg MSG
	for {
		select {
		case <-h.quit:
			procUnhookWindowsHookEx.Call(h.hookHandle)
			log.Info("hotkey: hook removed, shutting down")
			return
		default:
		}

		ret, _, _ := procPeekMessage.Call(
			uintptr(unsafe.Pointer(&msg)),
			0, 0, 0,
			1, // PM_REMOVE
		)
		if ret != 0 {
			continue
		}
		time.Sleep(10 * time.Millisecond)
	}
}
