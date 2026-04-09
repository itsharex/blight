//go:build darwin

package tray

type TrayIcon struct {
	onShow     func()
	onSettings func()
	onQuit     func()
}

func New(onShow, onSettings, onQuit func()) *TrayIcon {
	return &TrayIcon{
		onShow:     onShow,
		onSettings: onSettings,
		onQuit:     onQuit,
	}
}

func (t *TrayIcon) Start() {}

func (t *TrayIcon) Stop() {}
