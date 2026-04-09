package apps

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	shell32            = syscall.NewLazyDLL("shell32.dll")
	user32             = syscall.NewLazyDLL("user32.dll")
	gdi32              = syscall.NewLazyDLL("gdi32.dll")
	ole32              = syscall.NewLazyDLL("ole32.dll")
	procSHGetFileInfo  = shell32.NewProc("SHGetFileInfoW")
	procSHGetImageList = shell32.NewProc("SHGetImageList")
	procDestroyIcon    = user32.NewProc("DestroyIcon")
	procGetIconInfo    = user32.NewProc("GetIconInfo")
	procGetDIBits      = gdi32.NewProc("GetDIBits")
	procCreateCompatDC = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC       = gdi32.NewProc("DeleteDC")
	procDeleteObject   = gdi32.NewProc("DeleteObject")
	procGetObject      = gdi32.NewProc("GetObjectW")
	procCoInitializeEx = ole32.NewProc("CoInitializeEx")
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
)

const (
	shgfiIcon         = 0x000000100
	shgfiSmallIcon    = 0x000000001
	shgfiLargeIcon    = 0x000000000
	shgfiSYSICONINDEX = 0x000004000
	biRGB             = 0

	// Image list sizes
	SHIL_LARGE      = 0 // 32x32
	SHIL_SMALL      = 1 // 16x16
	SHIL_EXTRALARGE = 2 // 48x48
	SHIL_JUMBO      = 4 // 256x256 (Vista+)

	// IShellItemImageFactory flags (SIIGBF)
	SIIGBF_RESIZETOFIT  = 0x00
	SIIGBF_BIGGERSIZEOK = 0x01
	SIIGBF_MEMORYONLY   = 0x02
	SIIGBF_ICONONLY     = 0x04
	SIIGBF_THUMBNAILONLY = 0x08
)

// IID_IImageList GUID
var IID_IImageList = syscall.GUID{
	Data1: 0x46EB5926,
	Data2: 0x582E,
	Data3: 0x4017,
	Data4: [8]byte{0x9F, 0xDF, 0xE8, 0x99, 0x8D, 0xAA, 0x09, 0x50},
}

// IID_IShellItemImageFactory GUID
var IID_IShellItemImageFactory = syscall.GUID{
	Data1: 0xBCC18B79,
	Data2: 0xBA16,
	Data3: 0x442F,
	Data4: [8]byte{0x80, 0xC4, 0x8A, 0x59, 0xC3, 0x0C, 0x46, 0x3B},
}

// IID_IShellItem GUID
var IID_IShellItem = syscall.GUID{
	Data1: 0x43826D1E,
	Data2: 0xE718,
	Data3: 0x42EE,
	Data4: [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE},
}

type shFileInfo struct {
	HIcon         syscall.Handle
	IIcon         int32
	DwAttributes  uint32
	SzDisplayName [260]uint16
	SzTypeName    [80]uint16
}

type iconInfo struct {
	FIcon    int32
	XHotspot int32
	YHotspot int32
	HbmMask  syscall.Handle
	HbmColor syscall.Handle
}

type bitmap struct {
	Type       int32
	Width      int32
	Height     int32
	WidthBytes int32
	Planes     uint16
	BitsPixel  uint16
	Bits       uintptr
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type sizeStruct struct {
	Width  int32
	Height int32
}

var (
	iconCache   sync.Map
	comInitOnce sync.Once
)

func GetIconBase64(path string) string {
	if cached, ok := iconCache.Load(path); ok {
		return cached.(string)
	}

	iconPath := path

	// For .lnk files, resolve the target to avoid the shortcut arrow overlay.
	if strings.HasSuffix(strings.ToLower(path), ".lnk") {
		targetPath := ResolveLnkTarget(path)
		if targetPath != "" {
			// Check for a .ico file in the target app directory
			if icoPath := FindAppIcon(targetPath); icoPath != "" {
				iconPath = icoPath
			} else {
				iconPath = targetPath
			}
		}
	}

	// Try UWP/Store app icon first (high quality PNG asset)
	if data := extractUWPIcon(iconPath); data != "" {
		iconCache.Store(path, data)
		return data
	}

	// Modern API: IShellItemImageFactory (same approach as Flow Launcher's ThumbnailReader)
	if data := extractIconShellItemImageFactory(iconPath, 256); data != "" {
		iconCache.Store(path, data)
		return data
	}

	// Legacy API: SHGetImageList JUMBO
	if data := extractIconHQ(iconPath); data != "" {
		iconCache.Store(path, data)
		return data
	}

	// Fallback
	data := extractIcon(iconPath)
	iconCache.Store(path, data)
	return data
}

// extractIconShellItemImageFactory uses IShellItemImageFactory to get a high-quality icon.
func extractIconShellItemImageFactory(path string, size int) string {
	comInitOnce.Do(func() {
		procCoInitializeEx.Call(0, 0)
	})

	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}

	// Create an IShellItem for the path
	var shellItem uintptr
	hr, _, _ := procSHCreateItemFromParsingName.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		0,
		uintptr(unsafe.Pointer(&IID_IShellItem)),
		uintptr(unsafe.Pointer(&shellItem)),
	)
	if hr != 0 || shellItem == 0 {
		return ""
	}
	defer comRelease(shellItem)

	// QueryInterface for IShellItemImageFactory
	shellItemVtable := getVtable(shellItem)
	var imageFactory uintptr
	hr, _, _ = syscall.SyscallN(shellItemVtable[0], shellItem,
		uintptr(unsafe.Pointer(&IID_IShellItemImageFactory)),
		uintptr(unsafe.Pointer(&imageFactory)),
	)
	if hr != 0 || imageFactory == 0 {
		return ""
	}
	defer comRelease(imageFactory)

	// IShellItemImageFactory::GetImage(SIZE, SIIGBF, HBITMAP*)
	// SIIGBF_ICONONLY ensures we get the icon (not a thumbnail preview of file contents)
	sz := sizeStruct{Width: int32(size), Height: int32(size)}
	var hBitmap uintptr
	imageFactoryVtable := getVtable(imageFactory)
	// GetImage is at vtable index 3 (IUnknown has 3 methods: QI, AddRef, Release)
	hr, _, _ = syscall.SyscallN(imageFactoryVtable[3], imageFactory,
		uintptr(sz.Width),
		uintptr(sz.Height),
		SIIGBF_ICONONLY,
		uintptr(unsafe.Pointer(&hBitmap)),
	)
	if hr != 0 || hBitmap == 0 {
		return ""
	}
	defer procDeleteObject.Call(hBitmap)

	return hBitmapToPngBase64(syscall.Handle(hBitmap))
}

// extractUWPIcon tries to find the PNG icon assets for a UWP/Store application.
// UWP apps live under %ProgramFiles%\WindowsApps\<PackageFullName>\ and ship
// PNG assets declared in AppxManifest.xml.
func extractUWPIcon(exePath string) string {
	if exePath == "" {
		return ""
	}

	exeLower := strings.ToLower(exePath)

	// Quick check: is it a WindowsApps executable?
	if !strings.Contains(exeLower, `windowsapps\`) {
		return ""
	}

	// The package directory is the folder containing the exe
	packageDir := filepath.Dir(exePath)

	// Look for Assets/*.png — prefer scale-200 or scale-100 variants at sensible sizes
	assetsDir := filepath.Join(packageDir, "Assets")
	if _, err := os.Stat(assetsDir); err != nil {
		return ""
	}

	entries, err := os.ReadDir(assetsDir)
	if err != nil {
		return ""
	}

	// Priority: Square44x44Logo > Square150x150Logo > any *Logo*.png
	type candidate struct {
		path     string
		priority int
	}
	var candidates []candidate

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		nameLower := strings.ToLower(e.Name())
		if !strings.HasSuffix(nameLower, ".png") {
			continue
		}
		p := 0
		switch {
		case strings.Contains(nameLower, "square44x44logo"):
			p = 100
		case strings.Contains(nameLower, "square150x150logo"):
			p = 90
		case strings.Contains(nameLower, "applist"):
			p = 80
		case strings.Contains(nameLower, "logo"):
			p = 50
		default:
			p = 10
		}
		// Prefer scale-200 over scale-100 over unscaled
		if strings.Contains(nameLower, "scale-200") {
			p += 5
		} else if strings.Contains(nameLower, "scale-100") {
			p += 2
		}
		candidates = append(candidates, candidate{path: filepath.Join(assetsDir, e.Name()), priority: p})
	}

	if len(candidates) == 0 {
		return ""
	}

	// Find highest priority candidate
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.priority > best.priority {
			best = c
		}
	}

	// Read and encode the PNG as a data URI
	data, err := os.ReadFile(best.path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("data:image/png;base64,%s", base64.StdEncoding.EncodeToString(data))
}

func extractIconHQ(path string) string {
	comInitOnce.Do(func() {
		procCoInitializeEx.Call(0, 0)
	})

	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}

	var sfi shFileInfo
	ret, _, _ := procSHGetFileInfo.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		0,
		uintptr(unsafe.Pointer(&sfi)),
		unsafe.Sizeof(sfi),
		shgfiSYSICONINDEX,
	)
	if ret == 0 {
		return ""
	}
	iconIndex := sfi.IIcon

	// Try JUMBO first, then fall back to EXTRALARGE
	for _, size := range []uintptr{SHIL_JUMBO, SHIL_EXTRALARGE} {
		var imageList uintptr
		hr, _, _ := procSHGetImageList.Call(
			size,
			uintptr(unsafe.Pointer(&IID_IImageList)),
			uintptr(unsafe.Pointer(&imageList)),
		)
		if hr != 0 || imageList == 0 {
			continue
		}

		vtable := *(*[20]uintptr)(unsafe.Pointer(*(*uintptr)(unsafe.Pointer(imageList))))
		getIconFn := vtable[10] // IImageList::GetIcon at index 10

		var hIcon uintptr
		syscall.SyscallN(getIconFn, imageList, uintptr(iconIndex), 1, uintptr(unsafe.Pointer(&hIcon)))
		if hIcon == 0 {
			continue
		}
		defer procDestroyIcon.Call(hIcon)

		if data := hIconToPngBase64(syscall.Handle(hIcon)); data != "" {
			return data
		}
	}
	return ""
}

func extractIcon(path string) string {
	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}

	var sfi shFileInfo
	ret, _, _ := procSHGetFileInfo.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		0,
		uintptr(unsafe.Pointer(&sfi)),
		unsafe.Sizeof(sfi),
		shgfiIcon|shgfiLargeIcon,
	)

	if ret == 0 || sfi.HIcon == 0 {
		return ""
	}
	defer procDestroyIcon.Call(uintptr(sfi.HIcon))

	return hIconToPngBase64(sfi.HIcon)
}

func hBitmapToPngBase64(hBitmap syscall.Handle) string {
	hdc, _, _ := procCreateCompatDC.Call(0)
	if hdc == 0 {
		return ""
	}
	defer procDeleteDC.Call(hdc)

	var bm bitmap
	procGetObject.Call(uintptr(hBitmap), unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm)))

	width := int(bm.Width)
	height := int(bm.Height)
	if width == 0 || height == 0 {
		return ""
	}

	bih := bitmapInfoHeader{
		Size:     uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:    int32(width),
		Height:   -int32(height), // top-down
		Planes:   1,
		BitCount: 32,
	}

	pixels := make([]byte, width*height*4)
	procGetDIBits.Call(
		hdc,
		uintptr(hBitmap),
		0,
		uintptr(height),
		uintptr(unsafe.Pointer(&pixels[0])),
		uintptr(unsafe.Pointer(&bih)),
		0,
	)

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			i := (y*width + x) * 4
			img.Set(x, y, color.RGBA{
				R: pixels[i+2],
				G: pixels[i+1],
				B: pixels[i],
				A: pixels[i+3],
			})
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return ""
	}
	return fmt.Sprintf("data:image/png;base64,%s", base64.StdEncoding.EncodeToString(buf.Bytes()))
}

// hIconToPngBase64 converts an HICON to a PNG base64 data URI.
func hIconToPngBase64(hIcon syscall.Handle) string {
	var ii iconInfo
	ret, _, _ := procGetIconInfo.Call(uintptr(hIcon), uintptr(unsafe.Pointer(&ii)))
	if ret == 0 {
		return ""
	}

	if ii.HbmMask != 0 {
		defer procDeleteObject.Call(uintptr(ii.HbmMask))
	}
	if ii.HbmColor == 0 {
		return ""
	}
	defer procDeleteObject.Call(uintptr(ii.HbmColor))

	var bm bitmap
	procGetObject.Call(uintptr(ii.HbmColor), unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm)))

	width := int(bm.Width)
	height := int(bm.Height)
	if width == 0 || height == 0 {
		return ""
	}

	hdc, _, _ := procCreateCompatDC.Call(0)
	if hdc == 0 {
		return ""
	}
	defer procDeleteDC.Call(hdc)

	bih := bitmapInfoHeader{
		Size:     uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:    int32(width),
		Height:   -int32(height), // top-down
		Planes:   1,
		BitCount: 32,
	}

	pixels := make([]byte, width*height*4)
	procGetDIBits.Call(
		hdc,
		uintptr(ii.HbmColor),
		0,
		uintptr(height),
		uintptr(unsafe.Pointer(&pixels[0])),
		uintptr(unsafe.Pointer(&bih)),
		0,
	)

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			i := (y*width + x) * 4
			img.Set(x, y, color.RGBA{
				R: pixels[i+2],
				G: pixels[i+1],
				B: pixels[i],
				A: pixels[i+3],
			})
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return ""
	}
	return fmt.Sprintf("data:image/png;base64,%s", base64.StdEncoding.EncodeToString(buf.Bytes()))
}
