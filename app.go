package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"blight/internal/apps"
	"blight/internal/commands"
	"blight/internal/debug"
	"blight/internal/files"
	"blight/internal/hotkey"
	"blight/internal/search"
	"blight/internal/tray"
	"blight/internal/updater"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type UpdateInfo struct {
	Available bool   `json:"available"`
	Version   string `json:"version"`
	URL       string `json:"url"`
	Notes     string `json:"notes"`
	Error     string `json:"error,omitempty"`
}

type SearchResult struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
	Icon     string `json:"icon"`
	Category string `json:"category"`
	Path     string `json:"path"`
}

type ContextAction struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Icon  string `json:"icon"`
}

type BlightConfig struct {
	FirstRun     bool     `json:"firstRun"`
	Hotkey       string   `json:"hotkey"`
	MaxClipboard int      `json:"maxClipboard"`
	IndexDirs    []string `json:"indexDirs,omitempty"`
}

type App struct {
	ctx       context.Context
	config    BlightConfig
	scanner   *apps.Scanner
	usage     *search.UsageTracker
	clipboard *commands.ClipboardHistory
	fileIdx   *files.FileIndex
	hotkey    *hotkey.HotkeyManager
	tray      *tray.TrayIcon
	visible   atomic.Bool
	version   string
}

func NewApp(version string) *App {
	return &App{
		version: version,
	}
}

func (a *App) startup(ctx context.Context) {
	log := debug.Get()
	defer log.RecoverPanic("app.startup")

	log.Info("app.startup called", map[string]interface{}{"version": a.version})
	a.ctx = ctx
	a.visible.Store(true)
	a.loadConfig()
	log.Debug("config loaded", map[string]interface{}{"firstRun": a.config.FirstRun, "hotkey": a.config.Hotkey})

	a.scanner = apps.NewScanner()
	log.Info("app scanner initialized", map[string]interface{}{"appCount": len(a.scanner.Apps())})

	a.usage = search.NewUsageTracker()
	a.clipboard = commands.NewClipboardHistory(ctx)
	if a.config.MaxClipboard > 0 {
		a.clipboard.SetMaxSize(a.config.MaxClipboard)
	}
	go a.clipboard.PollClipboard()
	log.Debug("clipboard polling started")

	a.fileIdx = files.NewFileIndex(func(status files.IndexStatus) {
		log.Debug("index status changed", map[string]interface{}{"state": status.State, "message": status.Message, "count": status.Count})
		runtime.EventsEmit(ctx, "indexStatus", status)
	})
	a.fileIdx.Start()
	log.Info("file indexer started")

	a.hotkey = hotkey.New(func() {
		log.Debug("hotkey triggered (Alt+Space)")
		a.ToggleWindow()
	})
	a.hotkey.Start()
	log.Info("global hotkey registered (Alt+Space)")

	a.tray = tray.New(
		func() { a.ShowWindow() },
		func() {
			log.Info("settings requested from tray")
			a.ShowWindow()
			runtime.EventsEmit(a.ctx, "openSettings")
		},
		func() { runtime.Quit(ctx) },
	)
	a.tray.Start()
	log.Info("system tray icon created")

	log.Info("startup complete")
}

func (a *App) shutdown(ctx context.Context) {
	log := debug.Get()
	log.Info("shutdown called")
	if a.hotkey != nil {
		a.hotkey.Stop()
	}
	if a.tray != nil {
		a.tray.Stop()
	}
	log.Info("cleanup complete")
}

func (a *App) CheckForUpdates() UpdateInfo {
	u := updater.New("devatblight/blight")
	log := debug.Get()

	log.Info("checking for updates", map[string]interface{}{"current": a.version})

	rel, found, err := u.CheckForUpdates(a.version)
	if err != nil {
		log.Error("update check failed", map[string]interface{}{"error": err.Error()})
		return UpdateInfo{Error: err.Error()}
	}

	if !found {
		log.Info("no updates found")
		return UpdateInfo{Available: false}
	}

	log.Info("update available", map[string]interface{}{"version": rel.Version})

	return UpdateInfo{
		Available: true,
		Version:   rel.Version,
		URL:       rel.URL,
		Notes:     rel.Notes,
	}
}

func (a *App) InstallUpdate() string {
	log := debug.Get()
	u := updater.New("devatblight/blight")

	rel, found, err := u.CheckForUpdates(a.version)
	if err != nil {
		return "Check failed: " + err.Error()
	}
	if !found {
		return "No update found"
	}

	log.Info("installing update", map[string]interface{}{"version": rel.Version})
	if err := u.ApplyUpdate(rel); err != nil {
		log.Error("update failed", map[string]interface{}{"error": err.Error()})
		return "Update failed: " + err.Error()
	}

	log.Info("update applied — NSIS installer will handle the restart")

	// The NSIS installer (run with /S) kills the process and relaunches.
	// Give it a moment then quit so the installer can replace the binary.
	go func() {
		time.Sleep(2 * time.Second)
		runtime.Quit(a.ctx)
	}()

	return "success"
}

func (a *App) GetVersion() string {
	return a.version
}

func (a *App) ToggleWindow() {
	if a.visible.Load() {
		runtime.WindowHide(a.ctx)
		a.visible.Store(false)
	} else {
		runtime.WindowShow(a.ctx)
		runtime.WindowSetAlwaysOnTop(a.ctx, true)
		a.visible.Store(true)
	}
}

func (a *App) ShowWindow() {
	runtime.WindowShow(a.ctx)
	runtime.WindowSetAlwaysOnTop(a.ctx, true)
	a.visible.Store(true)
}

func (a *App) configDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".blight")
}

func (a *App) configPath() string {
	return filepath.Join(a.configDir(), "config.json")
}

func (a *App) loadConfig() {
	data, err := os.ReadFile(a.configPath())
	if err != nil {
		a.config = BlightConfig{FirstRun: true, Hotkey: "Alt+Space", MaxClipboard: 50}
		return
	}
	if err := json.Unmarshal(data, &a.config); err != nil {
		a.config = BlightConfig{FirstRun: true, Hotkey: "Alt+Space", MaxClipboard: 50}
		return
	}
	if a.config.MaxClipboard == 0 {
		a.config.MaxClipboard = 50
	}
}

func (a *App) saveConfig() error {
	if err := os.MkdirAll(a.configDir(), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(a.config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.configPath(), data, 0644)
}

func (a *App) IsFirstRun() bool {
	return a.config.FirstRun
}

func (a *App) CompleteOnboarding(hotkey string) error {
	a.config.FirstRun = false
	if hotkey != "" {
		a.config.Hotkey = hotkey
	}
	return a.saveConfig()
}

// GetConfig returns the current config for the settings UI.
func (a *App) GetConfig() BlightConfig {
	return a.config
}

// SaveSettings persists hotkey and clipboard size from the settings UI.
func (a *App) SaveSettings(hotkey string, maxClipboard int) error {
	if hotkey != "" {
		a.config.Hotkey = hotkey
	}
	if maxClipboard > 0 {
		a.config.MaxClipboard = maxClipboard
		a.clipboard.SetMaxSize(maxClipboard)
	}
	return a.saveConfig()
}

func (a *App) Search(query string) []SearchResult {
	log := debug.Get()
	if query == "" {
		return a.getDefaultResults()
	}

	var results []SearchResult

	if commands.IsCalcQuery(query) {
		calc := commands.Evaluate(query)
		if calc.Valid {
			results = append(results, SearchResult{
				ID:       "calc-result",
				Title:    calc.Result,
				Subtitle: calc.Expression + " — press Enter to copy",
				Icon:     "",
				Category: "Calculator",
			})
		}
	}

	queryLower := strings.ToLower(query)
	if strings.HasPrefix(queryLower, "cb ") || strings.HasPrefix(queryLower, "clip ") || queryLower == "clipboard" || queryLower == "cb" || queryLower == "clip" {
		entries := a.clipboard.Entries()
		limit := 8
		if len(entries) < limit {
			limit = len(entries)
		}
		for i, entry := range entries[:limit] {
			preview := entry.Content
			if len(preview) > 80 {
				preview = preview[:80] + "…"
			}
			results = append(results, SearchResult{
				ID:       fmt.Sprintf("clip-%d", i),
				Title:    preview,
				Subtitle: "Clipboard — press Enter to copy",
				Icon:     "",
				Category: "Clipboard",
			})
		}
	}

	results = append(results, a.searchSystemCommands(query)...)
	results = append(results, a.searchApps(query)...)
	results = append(results, a.searchFiles(query)...)

	if len(results) == 0 {
		return []SearchResult{
			{
				ID:       "web-search:" + query,
				Title:    "Search the web for \"" + query + "\"",
				Subtitle: "Opens in your default browser",
				Icon:     "",
				Category: "Web",
			},
		}
	}

	// Always append a web search option at the bottom for non-empty queries
	results = append(results, SearchResult{
		ID:       "web-search:" + query,
		Title:    "Search the web for \"" + query + "\"",
		Subtitle: "Opens in your default browser",
		Icon:     "",
		Category: "Web",
	})

	log.Debug("search", map[string]interface{}{"query": query, "results": len(results)})
	return results
}

func (a *App) Execute(id string) string {
	debug.Get().Info("execute", map[string]interface{}{"id": id})

	if strings.HasPrefix(id, "web-search:") {
		query := strings.TrimPrefix(id, "web-search:")
		searchURL := "https://www.google.com/search?q=" + url.QueryEscape(query)
		runtime.BrowserOpenURL(a.ctx, searchURL)
		runtime.WindowHide(a.ctx)
		a.visible.Store(false)
		return "ok"
	}

	if id == "calc-result" {
		runtime.ClipboardSetText(a.ctx, "")
		return "copied"
	}

	if strings.HasPrefix(id, "clip-") {
		idxStr := strings.TrimPrefix(id, "clip-")
		var idx int
		fmt.Sscanf(idxStr, "%d", &idx)
		if a.clipboard.CopyToClipboard(idx) {
			return "copied"
		}
		return "error"
	}

	if strings.HasPrefix(id, "sys-") {
		sysID := strings.TrimPrefix(id, "sys-")
		if err := commands.ExecuteSystemCommand(sysID); err != nil {
			return err.Error()
		}
		return "ok"
	}

	if strings.HasPrefix(id, "file-open:") {
		filePath := strings.TrimPrefix(id, "file-open:")
		shellOpen(filePath)
		runtime.WindowHide(a.ctx)
		a.visible.Store(false)
		return "ok"
	}

	if strings.HasPrefix(id, "file-reveal:") {
		filePath := strings.TrimPrefix(id, "file-reveal:")
		explorerSelect(filePath)
		return "ok"
	}

	allApps := a.scanner.Apps()
	for _, app := range allApps {
		if app.Name == id {
			a.usage.Record(id)
			if err := apps.Launch(app); err != nil {
				return err.Error()
			}
			runtime.WindowHide(a.ctx)
			return "ok"
		}
	}
	return "not found"
}

func (a *App) GetContextActions(id string) []ContextAction {
	switch {
	case strings.HasPrefix(id, "file-open:"):
		return []ContextAction{
			{ID: "open", Label: "Open", Icon: "▶"},
			{ID: "explorer", Label: "Show in Explorer", Icon: "📂"},
			{ID: "copy-path", Label: "Copy Path", Icon: "📋"},
			{ID: "copy-name", Label: "Copy Name", Icon: "📝"},
		}
	case strings.HasPrefix(id, "clip-"):
		return []ContextAction{
			{ID: "copy", Label: "Copy", Icon: "📋"},
			{ID: "delete", Label: "Delete", Icon: "🗑️"},
		}
	case strings.HasPrefix(id, "sys-"):
		return []ContextAction{
			{ID: "run", Label: "Run", Icon: "▶"},
		}
	case id == "calc-result" || id == "no-results" || strings.HasPrefix(id, "web-search:"):
		return []ContextAction{}
	default:
		// App
		return []ContextAction{
			{ID: "open", Label: "Open", Icon: "▶"},
			{ID: "admin", Label: "Run as Administrator", Icon: "🛡️"},
			{ID: "explorer", Label: "Show in Explorer", Icon: "📂"},
			{ID: "copy-path", Label: "Copy Path", Icon: "📋"},
		}
	}
}

func (a *App) ExecuteContextAction(resultID string, actionID string) string {
	// Files
	if strings.HasPrefix(resultID, "file-open:") {
		filePath := strings.TrimPrefix(resultID, "file-open:")
		switch actionID {
		case "open":
			shellOpen(filePath)
			runtime.WindowHide(a.ctx)
			a.visible.Store(false)
			return "ok"
		case "explorer":
			explorerSelect(filePath)
			return "ok"
		case "copy-path":
			runtime.ClipboardSetText(a.ctx, filePath)
			return "ok"
		case "copy-name":
			runtime.ClipboardSetText(a.ctx, filepath.Base(filePath))
			return "ok"
		}
		return "unknown action"
	}

	// Clipboard entries
	if strings.HasPrefix(resultID, "clip-") {
		idxStr := strings.TrimPrefix(resultID, "clip-")
		var idx int
		fmt.Sscanf(idxStr, "%d", &idx)
		switch actionID {
		case "copy", "open":
			if a.clipboard.CopyToClipboard(idx) {
				return "copied"
			}
			return "error"
		case "delete":
			a.clipboard.Delete(idx)
			return "ok"
		}
		return "unknown action"
	}

	// System commands
	if strings.HasPrefix(resultID, "sys-") {
		if actionID == "run" {
			sysID := strings.TrimPrefix(resultID, "sys-")
			if err := commands.ExecuteSystemCommand(sysID); err != nil {
				return err.Error()
			}
			return "ok"
		}
		return "unknown action"
	}

	// Apps
	allApps := a.scanner.Apps()
	var target apps.AppEntry
	found := false

	for _, app := range allApps {
		if app.Name == resultID {
			target = app
			found = true
			break
		}
	}

	if !found {
		return "not found"
	}

	switch actionID {
	case "open":
		a.usage.Record(resultID)
		if err := apps.Launch(target); err != nil {
			return err.Error()
		}
		runtime.WindowHide(a.ctx)
		return "ok"

	case "admin":
		a.usage.Record(resultID)
		err := runAsAdmin(target.Path)
		if err != nil {
			return err.Error()
		}
		runtime.WindowHide(a.ctx)
		return "ok"

	case "explorer":
		explorerSelect(target.Path)
		return "ok"

	case "copy-path":
		runtime.ClipboardSetText(a.ctx, target.Path)
		return "ok"
	}

	return "unknown action"
}

func (a *App) GetIcon(path string) string {
	return apps.GetIconBase64(path)
}

func (a *App) HideWindow() {
	runtime.WindowHide(a.ctx)
	a.visible.Store(false)
}

func (a *App) RefreshApps() {
	a.scanner.Scan()
}

func (a *App) GetIndexStatus() files.IndexStatus {
	return a.fileIdx.Status()
}

func (a *App) ReindexFiles() {
	a.fileIdx.Reindex()
}

func (a *App) ClearIndex() {
	a.fileIdx.ClearIndex()
}

func (a *App) searchFiles(query string) []SearchResult {
	if len(query) < 3 {
		return nil
	}

	status := a.fileIdx.Status()
	if status.State != "ready" {
		return nil
	}

	fileResults := a.fileIdx.SearchFiles(query)
	if len(fileResults) > 5 {
		fileResults = fileResults[:5]
	}

	var results []SearchResult
	for _, f := range fileResults {
		results = append(results, SearchResult{
			ID:       "file-open:" + f.Path,
			Title:    f.Name,
			Subtitle: prettifyPath(f.Dir),
			Icon:     "",
			Category: "Files",
			Path:     f.Path,
		})
	}

	return results
}

func (a *App) searchSystemCommands(query string) []SearchResult {
	queryLower := strings.ToLower(query)
	var results []SearchResult

	for _, cmd := range commands.SystemCommands {
		matched := false
		if strings.Contains(strings.ToLower(cmd.Name), queryLower) {
			matched = true
		}
		for _, keyword := range cmd.Keywords {
			if strings.Contains(keyword, queryLower) {
				matched = true
				break
			}
		}
		if matched {
			results = append(results, SearchResult{
				ID:       "sys-" + cmd.ID,
				Title:    cmd.Name,
				Subtitle: cmd.Subtitle,
				Icon:     "",
				Category: "System",
			})
		}
	}

	return results
}

func (a *App) searchApps(query string) []SearchResult {
	allApps := a.scanner.Apps()
	names := a.scanner.Names()

	usageScores := make([]int, len(allApps))
	for i, app := range allApps {
		usageScores[i] = a.usage.Score(app.Name)
	}

	matches := search.Fuzzy(query, names, usageScores)

	var results []SearchResult
	limit := 10
	if len(matches) < limit {
		limit = len(matches)
	}

	for _, match := range matches[:limit] {
		app := allApps[match.Index]

		subtitle := "Application"
		if !app.IsLnk {
			subtitle = prettifyPath(app.Path)
		}

		// Icons are loaded asynchronously by the frontend via GetIcon(path)
		results = append(results, SearchResult{
			ID:       app.Name,
			Title:    app.Name,
			Subtitle: subtitle,
			Icon:     "",
			Category: "Applications",
			Path:     app.Path,
		})
	}

	return results
}

func (a *App) getDefaultResults() []SearchResult {
	allApps := a.scanner.Apps()

	names := a.scanner.Names()
	usageScores := make([]int, len(allApps))
	for i, app := range allApps {
		usageScores[i] = a.usage.Score(app.Name)
	}
	matches := search.Fuzzy("", names, usageScores)

	count := 6
	if len(matches) < count {
		count = len(matches)
	}

	var results []SearchResult
	for _, match := range matches[:count] {
		app := allApps[match.Index]
		category := "Suggested"
		if a.usage.Score(app.Name) > 0 {
			category = "Recent"
		}
		subtitle := "Application"
		if !app.IsLnk {
			subtitle = prettifyPath(app.Path)
		}
		// Icons are loaded asynchronously by the frontend via GetIcon(path)
		results = append(results, SearchResult{
			ID:       app.Name,
			Title:    app.Name,
			Subtitle: subtitle,
			Icon:     "",
			Category: category,
			Path:     app.Path,
		})
	}

	return results
}

func prettifyPath(path string) string {
	home, _ := os.UserHomeDir()
	if strings.HasPrefix(path, home) {
		return "~" + path[len(home):]
	}
	return path
}

var (
	procShellExecute = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
)

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
