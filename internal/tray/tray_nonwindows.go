//go:build linux

package tray

import (
	"sync/atomic"

	"github.com/getlantern/systray"
)

type TrayIcon struct {
	onShow     func()
	onSettings func()
	onQuit     func()
	started    atomic.Bool
}

func New(onShow, onSettings, onQuit func()) *TrayIcon {
	return &TrayIcon{
		onShow:     onShow,
		onSettings: onSettings,
		onQuit:     onQuit,
	}
}

func (t *TrayIcon) Start() {
	if t.started.Swap(true) {
		return
	}
	go systray.Run(func() {
		systray.SetTitle("blight")
		systray.SetTooltip("blight")

		showItem := systray.AddMenuItem("Show blight", "Show blight window")
		settingsItem := systray.AddMenuItem("Settings", "Open settings")
		systray.AddSeparator()
		quitItem := systray.AddMenuItem("Quit", "Quit blight")

		go func() {
			for {
				select {
				case <-showItem.ClickedCh:
					if t.onShow != nil {
						t.onShow()
					}
				case <-settingsItem.ClickedCh:
					if t.onSettings != nil {
						t.onSettings()
					}
				case <-quitItem.ClickedCh:
					if t.onQuit != nil {
						t.onQuit()
					}
					return
				}
			}
		}()
	}, func() {
		t.started.Store(false)
	})
}

func (t *TrayIcon) Stop() {
	if !t.started.Load() {
		return
	}
	systray.Quit()
}
