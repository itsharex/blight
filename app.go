package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"unsafe"

	"blight/internal/apps"
	"blight/internal/commands"
	"blight/internal/debug"
	"blight/internal/files"
	"blight/internal/hotkey"
	"blight/internal/search"
	"blight/internal/startup"
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
	// Core
	FirstRun     bool     `json:"firstRun"`
	Hotkey       string   `json:"hotkey"`
	MaxClipboard int      `json:"maxClipboard"`
	IndexDirs    []string `json:"indexDirs,omitempty"`

	// Search behaviour (inspired by Flow Launcher)
	MaxResults  int `json:"maxResults"`  // max results per category total, default 8
	SearchDelay int `json:"searchDelay"` // debounce delay in ms, default 120

	// Window behaviour
	HideWhenDeactivated bool   `json:"hideWhenDeactivated"` // hide on focus loss, default true
	LastQueryMode       string `json:"lastQueryMode"`       // "clear"|"preserve", default "clear"
	WindowPosition      string `json:"windowPosition"`      // "center"|"cursor"|"top-center", default "center"

	// Appearance
	UseAnimation    bool   `json:"useAnimation"`    // enable animations, default true
	ShowPlaceholder bool   `json:"showPlaceholder"` // show search placeholder, default true
	PlaceholderText string `json:"placeholderText"` // custom placeholder text, default ""
	Theme           string `json:"theme"`           // "dark"|"light"|"system", default "dark"

	// System integration
	StartOnStartup bool `json:"startOnStartup"` // add to Windows startup, default false
	HideNotifyIcon bool `json:"hideNotifyIcon"` // hide system tray icon, default false
}

type App struct {
	ctx          context.Context
	config       BlightConfig
	scanner      *apps.Scanner
	usage        *search.UsageTracker
	clipboard    *commands.ClipboardHistory
	fileIdx      *files.FileIndex
	hotkey       *hotkey.HotkeyManager
	tray         *tray.TrayIcon
	visible      atomic.Bool
	version      string
	settingsMode bool // true when running as the --settings child process
}

func NewApp(version string) *App {
	return &App{version: version}
}

func NewSettingsApp(version string) *App {
	return &App{version: version, settingsMode: true}
}

func (a *App) startup(ctx context.Context) {
	if a.settingsMode {
		a.settingsOnlyStartup(ctx)
		return
	}

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

	a.fileIdx = files.NewFileIndex(a.config.IndexDirs, func(status files.IndexStatus) {
		log.Debug("index status changed", map[string]interface{}{"state": status.State, "message": status.Message, "count": status.Count})
		runtime.EventsEmit(ctx, "indexStatus", status)
	})
	a.fileIdx.Start()
	log.Info("file indexer started")

	hotkeyStr := a.config.Hotkey
	if hotkeyStr == "" {
		hotkeyStr = "Alt+Space"
	}
	a.hotkey = hotkey.New(hotkeyStr, func() {
		log.Debug("hotkey triggered", map[string]interface{}{"hotkey": hotkeyStr})
		a.ToggleWindow()
	})
	a.hotkey.Start()
	log.Info("global hotkey registered", map[string]interface{}{"hotkey": hotkeyStr})

	a.tray = tray.New(
		func() { a.ShowWindow() },
		func() {
			log.Info("settings requested from tray")
			a.OpenSettingsWindow()
		},
		func() { runtime.Quit(ctx) },
	)
	a.tray.Start()
	log.Info("system tray icon created")

	log.Info("startup complete")
}

// settingsOnlyStartup is the minimal startup for the --settings child process.
func (a *App) settingsOnlyStartup(ctx context.Context) {
	a.ctx = ctx
	a.loadConfig()
	// Tell the frontend to enter settings-only mode immediately
	runtime.EventsEmit(ctx, "openSettings")
}

// settingsShutdown is used by the --settings child process.
func (a *App) settingsShutdown(_ context.Context) {}

// CloseSettings quits the settings window process.
func (a *App) CloseSettings() {
	runtime.Quit(a.ctx)
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

	log.Info("update applied — NSIS installer will handle kill and relaunch")

	// The NSIS installer runs silently: it does taskkill /f /im blight.exe,
	// installs the new version, then launches blight.exe.
	// We just return "success" so the UI can show a status message.
	// The installer will forcefully kill us when it's ready.
	return "success"
}

func (a *App) GetVersion() string {
	return a.version
}

// IsSettingsMode returns true when running as the --settings child process.
func (a *App) IsSettingsMode() bool { return a.settingsMode }

// OpenSettingsWindow spawns blight.exe --settings as a separate OS window.
func (a *App) OpenSettingsWindow() {
	log := debug.Get()
	exe, err := os.Executable()
	if err != nil {
		log.Error("OpenSettingsWindow: could not get executable path", map[string]interface{}{"error": err.Error()})
		return
	}
	cmd := exec.Command(exe, "--settings")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
	if err := cmd.Start(); err != nil {
		log.Error("OpenSettingsWindow: failed to spawn settings window", map[string]interface{}{"error": err.Error()})
	}
}

func (a *App) ToggleWindow() {
	if a.visible.Load() {
		runtime.WindowHide(a.ctx)
		a.visible.Store(false)
	} else {
		// Reload config so changes saved in the settings window take effect
		a.loadConfig()
		runtime.WindowShow(a.ctx)
		runtime.WindowSetAlwaysOnTop(a.ctx, true)
		runtime.EventsEmit(a.ctx, "windowShown")
		a.visible.Store(true)
	}
}

func (a *App) ShowWindow() {
	a.loadConfig()
	runtime.WindowShow(a.ctx)
	runtime.WindowSetAlwaysOnTop(a.ctx, true)
	runtime.EventsEmit(a.ctx, "windowShown")
	a.visible.Store(true)
}

func (a *App) configDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".blight")
}

func (a *App) configPath() string {
	return filepath.Join(a.configDir(), "config.json")
}

func defaultConfig() BlightConfig {
	return BlightConfig{
		FirstRun:            true,
		Hotkey:              "Alt+Space",
		MaxClipboard:        50,
		MaxResults:          8,
		SearchDelay:         120,
		HideWhenDeactivated: true,
		LastQueryMode:       "clear",
		WindowPosition:      "center",
		UseAnimation:        true,
		ShowPlaceholder:     true,
		PlaceholderText:     "",
		Theme:               "dark",
		StartOnStartup:      false,
		HideNotifyIcon:      false,
	}
}

func (a *App) loadConfig() {
	data, err := os.ReadFile(a.configPath())
	if err != nil {
		a.config = defaultConfig()
		return
	}
	// Start with defaults so new fields are initialised even on old config files
	a.config = defaultConfig()
	if err := json.Unmarshal(data, &a.config); err != nil {
		a.config = defaultConfig()
		return
	}
	// Clamp / validate
	if a.config.MaxClipboard == 0 {
		a.config.MaxClipboard = 50
	}
	if a.config.MaxResults == 0 {
		a.config.MaxResults = 8
	}
	if a.config.SearchDelay == 0 {
		a.config.SearchDelay = 120
	}
	if a.config.LastQueryMode == "" {
		a.config.LastQueryMode = "clear"
	}
	if a.config.WindowPosition == "" {
		a.config.WindowPosition = "center"
	}
	if a.config.Theme == "" {
		a.config.Theme = "dark"
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

// SaveSettings persists settings from the settings UI.
// cfg is a partial BlightConfig — only non-zero/non-empty fields overwrite the
// current config so the frontend can send only the fields it knows about.
func (a *App) SaveSettings(cfg BlightConfig) error {
	log := debug.Get()

	if cfg.Hotkey != "" {
		a.config.Hotkey = cfg.Hotkey
	}
	if cfg.MaxClipboard > 0 {
		a.config.MaxClipboard = cfg.MaxClipboard
		if a.clipboard != nil {
			a.clipboard.SetMaxSize(cfg.MaxClipboard)
		}
	}
	if cfg.IndexDirs != nil {
		a.config.IndexDirs = cfg.IndexDirs
	}
	if cfg.MaxResults > 0 {
		a.config.MaxResults = cfg.MaxResults
	}
	if cfg.SearchDelay > 0 {
		a.config.SearchDelay = cfg.SearchDelay
	}
	if cfg.LastQueryMode != "" {
		a.config.LastQueryMode = cfg.LastQueryMode
	}
	if cfg.WindowPosition != "" {
		a.config.WindowPosition = cfg.WindowPosition
	}
	if cfg.Theme != "" {
		a.config.Theme = cfg.Theme
	}
	if cfg.PlaceholderText != "" {
		a.config.PlaceholderText = cfg.PlaceholderText
	}
	// Boolean fields are always updated (they can legitimately be false)
	a.config.HideWhenDeactivated = cfg.HideWhenDeactivated
	a.config.UseAnimation = cfg.UseAnimation
	a.config.ShowPlaceholder = cfg.ShowPlaceholder
	a.config.HideNotifyIcon = cfg.HideNotifyIcon

	// System startup: sync Windows registry
	if cfg.StartOnStartup != a.config.StartOnStartup {
		a.config.StartOnStartup = cfg.StartOnStartup
		if cfg.StartOnStartup {
			if err := startup.Enable(); err != nil {
				log.Error("startup.Enable failed", map[string]interface{}{"error": err.Error()})
			}
		} else {
			if err := startup.Disable(); err != nil {
				log.Error("startup.Disable failed", map[string]interface{}{"error": err.Error()})
			}
		}
	}

	// Tray icon visibility
	if a.tray != nil {
		if a.config.HideNotifyIcon {
			a.tray.Stop()
		} else {
			a.tray.Start()
		}
	}

	return a.saveConfig()
}

// GetStartupEnabled returns whether blight is currently registered to start on login.
func (a *App) GetStartupEnabled() bool {
	return startup.IsEnabled()
}

func (a *App) Search(query string) []SearchResult {
	log := debug.Get()
	if query == "" {
		return a.getDefaultResults()
	}

	var results []SearchResult

	// URL detection: if the query looks like a URL, offer to open it directly.
	if isURL(query) {
		results = append(results, SearchResult{
			ID:       "url-open:" + query,
			Title:    "Open URL",
			Subtitle: query,
			Icon:     "",
			Category: "Web",
		})
	}

	// Path detection: if query looks like a Windows file path, offer to open it.
	if isFilePath(query) {
		results = append(results, SearchResult{
			ID:       "file-open:" + query,
			Title:    filepath.Base(query),
			Subtitle: "Open: " + query,
			Icon:     "",
			Category: "Files",
			Path:     query,
		})
	}

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

	if strings.HasPrefix(id, "url-open:") {
		target := strings.TrimPrefix(id, "url-open:")
		runtime.BrowserOpenURL(a.ctx, target)
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

func (a *App) maxResults() int {
	if a.config.MaxResults > 0 {
		return a.config.MaxResults
	}
	return 8
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
	limit := a.maxResults()
	if len(fileResults) > limit {
		fileResults = fileResults[:limit]
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
	limit := a.maxResults()
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

// isURL returns true if s looks like an http/https/ftp URL.
func isURL(s string) bool {
	sl := strings.ToLower(s)
	return strings.HasPrefix(sl, "http://") ||
		strings.HasPrefix(sl, "https://") ||
		strings.HasPrefix(sl, "ftp://")
}

// isFilePath returns true if s looks like a Windows absolute path or UNC path.
func isFilePath(s string) bool {
	if len(s) >= 3 && s[1] == ':' && (s[2] == '\\' || s[2] == '/') {
		return true // e.g. C:\foo
	}
	if strings.HasPrefix(s, `\\`) {
		return true // UNC path
	}
	return false
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
