//go:build !windows

package hotkey

type HotkeyManager struct {
	callback func()
}

func New(_ string, callback func()) *HotkeyManager {
	return &HotkeyManager{callback: callback}
}

func (h *HotkeyManager) Start() error {
	return nil
}

func (h *HotkeyManager) Stop() {}
