// Package startup manages the "run on system startup" feature via the Windows registry.
// It writes/removes a value under HKCU\Software\Microsoft\Windows\CurrentVersion\Run
// so blight launches automatically when the user logs in.
package startup

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const regRunPath = `Software\Microsoft\Windows\CurrentVersion\Run`

var (
	advapi32           = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKeyEx   = advapi32.NewProc("RegOpenKeyExW")
	procRegSetValueEx  = advapi32.NewProc("RegSetValueExW")
	procRegDeleteValue = advapi32.NewProc("RegDeleteValueW")
	procRegQueryValueEx = advapi32.NewProc("RegQueryValueExW")
	procRegCloseKey    = advapi32.NewProc("RegCloseKey")
)

const (
	hkeyCurrentUser  = uintptr(0x80000001)
	keySetValue      = uint32(0x0002)
	keyQueryValue    = uint32(0x0001)
	regSZ            = uint32(1)
)

func openRunKey(access uint32) (uintptr, error) {
	path, _ := syscall.UTF16PtrFromString(regRunPath)
	var hkey uintptr
	ret, _, _ := procRegOpenKeyEx.Call(
		hkeyCurrentUser,
		uintptr(unsafe.Pointer(path)),
		0,
		uintptr(access),
		uintptr(unsafe.Pointer(&hkey)),
	)
	if ret != 0 {
		return 0, syscall.Errno(ret)
	}
	return hkey, nil
}

// Enable adds blight to the Windows startup registry key.
func Enable() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return err
	}

	hkey, err := openRunKey(keySetValue)
	if err != nil {
		return err
	}
	defer procRegCloseKey.Call(hkey)

	valueName, _ := syscall.UTF16PtrFromString("blight")
	value := `"` + exe + `"`
	valuePtr, _ := syscall.UTF16PtrFromString(value)
	// Size in bytes including null terminator
	size := uint32((len([]rune(value)) + 1) * 2)

	ret, _, _ := procRegSetValueEx.Call(
		hkey,
		uintptr(unsafe.Pointer(valueName)),
		0,
		uintptr(regSZ),
		uintptr(unsafe.Pointer(valuePtr)),
		uintptr(size),
	)
	if ret != 0 {
		return syscall.Errno(ret)
	}
	return nil
}

// Disable removes blight from the Windows startup registry key.
func Disable() error {
	hkey, err := openRunKey(keySetValue)
	if err != nil {
		return err
	}
	defer procRegCloseKey.Call(hkey)

	valueName, _ := syscall.UTF16PtrFromString("blight")
	ret, _, _ := procRegDeleteValue.Call(hkey, uintptr(unsafe.Pointer(valueName)))
	if ret != 0 {
		return syscall.Errno(ret)
	}
	return nil
}

// IsEnabled returns true if blight is registered for startup.
func IsEnabled() bool {
	hkey, err := openRunKey(keyQueryValue)
	if err != nil {
		return false
	}
	defer procRegCloseKey.Call(hkey)

	valueName, _ := syscall.UTF16PtrFromString("blight")
	var dataType uint32
	var dataSize uint32
	ret, _, _ := procRegQueryValueEx.Call(
		hkey,
		uintptr(unsafe.Pointer(valueName)),
		0,
		uintptr(unsafe.Pointer(&dataType)),
		0,
		uintptr(unsafe.Pointer(&dataSize)),
	)
	return ret == 0
}
