//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var procShellExecute = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")

func configureSettingsCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
}

// shellOpen opens a file with its default handler via ShellExecuteW — no cmd.exe flash.
func shellOpen(path string) {
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(path)
	procShellExecute.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
}

// explorerSelect opens Windows Explorer with the file selected, without spawning a console.
func explorerSelect(path string) {
	arg, _ := syscall.UTF16PtrFromString("/select," + path)
	explorer, _ := syscall.UTF16PtrFromString("explorer.exe")
	procShellExecute.Call(0, 0, uintptr(unsafe.Pointer(explorer)), uintptr(unsafe.Pointer(arg)), 0, 1)
}

func runAsAdmin(path string) error {
	verb, _ := syscall.UTF16PtrFromString("runas")
	exe, _ := syscall.UTF16PtrFromString(path)
	cwd, _ := syscall.UTF16PtrFromString(filepath.Dir(path))

	ret, _, _ := procShellExecute.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(exe)),
		0,
		uintptr(unsafe.Pointer(cwd)),
		1, // SW_SHOWNORMAL
	)
	if ret <= 32 {
		return fmt.Errorf("ShellExecute failed with code %d", ret)
	}
	return nil
}
