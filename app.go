package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"slices"
	"strings"
	"sync/atomic"
	"time"

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
	StartOnStartup bool      `json:"startOnStartup"` // add to Windows startup, default false
	HideNotifyIcon bool      `json:"hideNotifyIcon"` // hide system tray icon, default false
	LastIndexedAt  time.Time `json:"lastIndexedAt,omitempty"`

	// File index behaviour
	DisableFolderIndex bool `json:"disableFolderIndex,omitempty"` // exclude folders from search results, default false

	// User-defined aliases: trigger → expansion (URL or text snippet)
	Aliases map[string]string `json:"aliases,omitempty"`
	// IDs of pinned items — shown first in spotlight view and boosted in search
	PinnedItems []string `json:"pinnedItems,omitempty"`
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
	lastShownAt  atomic.Int64 // Unix nanoseconds; updated on every show
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
		if status.State == "ready" {
			a.config.LastIndexedAt = time.Now()
			_ = a.saveConfig()
		}
	})
	const staleAge = 72 * time.Hour // 3 days
	if a.fileIdx.IsStale(staleAge) {
		a.fileIdx.Start()
	}
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
	err = u.ApplyUpdateWithProgress(rel, func(pct int) {
		runtime.EventsEmit(a.ctx, "updateProgress", pct)
	})
	if err != nil {
		log.Error("update failed", map[string]interface{}{"error": err.Error()})
		return "Update failed: " + err.Error()
	}

	log.Info("update applied — NSIS installer will handle kill and relaunch")
	return "success"
}

func (a *App) GetDataDir() string {
	return a.configDir()
}

func (a *App) GetInstallDir() string {
	return blightInstallDir()
}

func (a *App) OpenFolder(path string) {
	shellOpen(path)
}

func (a *App) Uninstall() string {
	dir := blightInstallDir()
	uninst := filepath.Join(dir, "uninstall.exe")
	if _, err := os.Stat(uninst); err != nil {
		return "not-found:" + uninst
	}
	cmd := exec.Command(uninst)
	if err := cmd.Start(); err != nil {
		return "error:" + err.Error()
	}
	return "success"
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
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
	configureSettingsCommand(cmd)
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
		a.lastShownAt.Store(time.Now().UnixNano())
		runtime.WindowShow(a.ctx)
		runtime.WindowSetAlwaysOnTop(a.ctx, true)
		runtime.EventsEmit(a.ctx, "windowShown")
		a.visible.Store(true)
	}
}

func (a *App) ShowWindow() {
	a.loadConfig()
	a.lastShownAt.Store(time.Now().UnixNano())
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
		prev := a.config.Hotkey
		a.config.Hotkey = cfg.Hotkey
		if a.hotkey != nil && cfg.Hotkey != prev {
			a.hotkey.Stop()
			a.hotkey = hotkey.New(cfg.Hotkey, func() { a.ToggleWindow() })
			if err := a.hotkey.Start(); err != nil {
				log.Error("hotkey restart failed", map[string]interface{}{"error": err.Error()})
			} else {
				log.Info("global hotkey updated", map[string]interface{}{"hotkey": cfg.Hotkey})
			}
		}
	}
	if cfg.MaxClipboard > 0 {
		a.config.MaxClipboard = cfg.MaxClipboard
		if a.clipboard != nil {
			a.clipboard.SetMaxSize(cfg.MaxClipboard)
		}
	}
	if cfg.IndexDirs != nil {
		dirsChanged := !stringSlicesEqual(a.config.IndexDirs, cfg.IndexDirs)
		a.config.IndexDirs = cfg.IndexDirs
		if a.fileIdx != nil {
			a.fileIdx.UpdateDirs(cfg.IndexDirs)
			if dirsChanged {
				go a.fileIdx.Reindex()
			}
		}
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
	a.config.DisableFolderIndex = cfg.DisableFolderIndex

	if cfg.Aliases != nil {
		a.config.Aliases = cfg.Aliases
	}
	if cfg.PinnedItems != nil {
		a.config.PinnedItems = cfg.PinnedItems
	}

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

func (a *App) OpenFolderPicker() string {
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Directory to Index",
	})
	if err != nil {
		return ""
	}
	return path
}

func (a *App) Search(query string) []SearchResult {
	log := debug.Get()
	if query == "" {
		return a.getDefaultResults()
	}

	// Path-browser mode: ~ or any absolute path prefix triggers live dir listing.
	if strings.HasPrefix(query, "~") || isAbsPath(query) {
		return a.searchPath(query)
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

	// Aliases — match any trigger that starts with the query
	if len(a.config.Aliases) > 0 {
		qLower := strings.ToLower(query)
		for trigger, expansion := range a.config.Aliases {
			if strings.HasPrefix(strings.ToLower(trigger), qLower) {
				results = append(results, SearchResult{
					ID:       "alias:" + trigger,
					Title:    trigger,
					Subtitle: expansion,
					Category: "Aliases",
				})
			}
		}
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
	results = append(results, a.searchDirs(query)...)
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

	if strings.HasPrefix(id, "alias:") {
		trigger := strings.TrimPrefix(id, "alias:")
		expansion, ok := a.config.Aliases[trigger]
		if !ok {
			return "not found"
		}
		if strings.HasPrefix(expansion, "http://") || strings.HasPrefix(expansion, "https://") {
			runtime.BrowserOpenURL(a.ctx, expansion)
			runtime.WindowHide(a.ctx)
			a.visible.Store(false)
			return "ok"
		}
		runtime.ClipboardSetText(a.ctx, expansion)
		return "copied"
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

	if strings.HasPrefix(id, "dir-open:") {
		dirPath := strings.TrimPrefix(id, "dir-open:")
		shellOpen(dirPath)
		runtime.WindowHide(a.ctx)
		a.visible.Store(false)
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

// icon returns a Segoe MDL2/Fluent glyph on Windows and a plain emoji on other platforms.
// Segoe PUA codepoints are meaningless outside Windows, so we fall back to emoji elsewhere.
func icon(winGlyph, fallback string) string {
	if goruntime.GOOS == "windows" {
		return winGlyph
	}
	return fallback
}

func (a *App) GetContextActions(id string) []ContextAction {
	switch {
	case strings.HasPrefix(id, "dir-open:"):
		return []ContextAction{
			{ID: "open", Label: "Open", Icon: icon("\uE768", "▶")},
			{ID: "terminal", Label: "Open in Terminal", Icon: icon("\uE756", "⌨")},
			{ID: "copy-path", Label: "Copy Path", Icon: icon("\uE8C8", "📋")},
		}
	case strings.HasPrefix(id, "file-open:"):
		return []ContextAction{
			{ID: "open", Label: "Open", Icon: icon("\uE768", "▶")},
			{ID: "explorer", Label: "Show in Explorer", Icon: icon("\uE8B7", "📂")},
			{ID: "copy-path", Label: "Copy Path", Icon: icon("\uE8C8", "📋")},
			{ID: "copy-name", Label: "Copy Name", Icon: icon("\uE70F", "📝")},
		}
	case strings.HasPrefix(id, "clip-"):
		return []ContextAction{
			{ID: "copy", Label: "Copy", Icon: icon("\uE8C8", "📋")},
			{ID: "delete", Label: "Delete", Icon: icon("\uE74D", "🗑️")},
		}
	case strings.HasPrefix(id, "sys-"):
		return []ContextAction{
			{ID: "run", Label: "Run", Icon: icon("\uE768", "▶")},
		}
	case strings.HasPrefix(id, "alias:"):
		return []ContextAction{
			{ID: "open", Label: "Use", Icon: icon("\uE768", "▶")},
			{ID: "copy", Label: "Copy Expansion", Icon: icon("\uE8C8", "📋")},
			{ID: "delete-alias", Label: "Delete Alias", Icon: icon("\uE74D", "🗑️")},
		}
	case id == "calc-result" || id == "no-results" || strings.HasPrefix(id, "web-search:"):
		return []ContextAction{}
	default:
		// App — dynamic pin label and icon
		pinLabel := "Pin to Top"
		pinIcon := icon("\uE718", "📌")
		for _, p := range a.config.PinnedItems {
			if p == id {
				pinLabel = "Unpin from Top"
				pinIcon = icon("\uE77A", "📌")
				break
			}
		}
		return []ContextAction{
			{ID: "open", Label: "Open", Icon: icon("\uE768", "▶")},
			{ID: "admin", Label: "Run as Administrator", Icon: icon("\uE7EF", "🛡️")},
			{ID: "explorer", Label: "Show in Explorer", Icon: icon("\uE8B7", "📂")},
			{ID: "copy-path", Label: "Copy Path", Icon: icon("\uE8C8", "📋")},
			{ID: "pin", Label: pinLabel, Icon: pinIcon},
		}
	}
}

func (a *App) ExecuteContextAction(resultID string, actionID string) string {
	// Aliases
	if strings.HasPrefix(resultID, "alias:") {
		trigger := strings.TrimPrefix(resultID, "alias:")
		expansion, ok := a.config.Aliases[trigger]
		if !ok {
			return "not found"
		}
		switch actionID {
		case "open":
			if strings.HasPrefix(expansion, "http://") || strings.HasPrefix(expansion, "https://") {
				runtime.BrowserOpenURL(a.ctx, expansion)
				runtime.WindowHide(a.ctx)
				a.visible.Store(false)
			} else {
				runtime.ClipboardSetText(a.ctx, expansion)
			}
			return "ok"
		case "copy":
			runtime.ClipboardSetText(a.ctx, expansion)
			return "ok"
		case "delete-alias":
			delete(a.config.Aliases, trigger)
			_ = a.saveConfig()
			return "ok"
		}
		return "unknown action"
	}

	// Folders
	if strings.HasPrefix(resultID, "dir-open:") {
		dirPath := strings.TrimPrefix(resultID, "dir-open:")
		switch actionID {
		case "open":
			shellOpen(dirPath)
			runtime.WindowHide(a.ctx)
			a.visible.Store(false)
			return "ok"
		case "terminal":
			openInTerminal(dirPath)
			return "ok"
		case "copy-path":
			runtime.ClipboardSetText(a.ctx, dirPath)
			return "ok"
		}
		return "unknown action"
	}

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

	case "pin":
		pinned := a.TogglePinned(resultID)
		if pinned {
			return "pinned"
		}
		return "unpinned"
	}

	return "unknown action"
}

func (a *App) GetIcon(path string) string {
	return apps.GetIconBase64(path)
}

// HideWindow is called by the frontend blur handler. It ignores the request if
// the window was shown very recently — this prevents a blur that fires as a
// side-effect of the hotkey show action from immediately re-hiding the window.
func (a *App) HideWindow() {
	const gracePeriod = 600 * time.Millisecond
	if time.Since(time.Unix(0, a.lastShownAt.Load())) < gracePeriod {
		return
	}
	runtime.WindowHide(a.ctx)
	a.visible.Store(false)
}

func (a *App) RefreshApps() {
	a.scanner.Scan()
}

func (a *App) GetIndexStatus() files.IndexStatus {
	return a.fileIdx.Status()
}

// ExportSettings returns the current config as a JSON string.
func (a *App) ExportSettings() string {
	data, err := json.MarshalIndent(a.config, "", "  ")
	if err != nil {
		return ""
	}
	return string(data)
}

// ImportSettings replaces the current config with one parsed from a JSON string.
func (a *App) ImportSettings(data string) error {
	var cfg BlightConfig
	if err := json.Unmarshal([]byte(data), &cfg); err != nil {
		return fmt.Errorf("invalid settings JSON: %w", err)
	}
	a.config = cfg
	return a.saveConfig()
}

// GetUsageScores returns a map of item ID → decayed usage score for items with
// at least one recorded use. Used by the frontend to show frequency indicators.
func (a *App) GetUsageScores() map[string]int {
	scores := make(map[string]int)
	for _, app := range a.scanner.Apps() {
		if s := a.usage.Score(app.Name); s > 0 {
			scores[app.Name] = s
		}
	}
	return scores
}

// GetAliases returns the current alias map (trigger → expansion).
func (a *App) GetAliases() map[string]string {
	if a.config.Aliases == nil {
		return map[string]string{}
	}
	return a.config.Aliases
}

// SaveAlias creates or updates an alias.
func (a *App) SaveAlias(trigger, expansion string) error {
	trigger = strings.TrimSpace(trigger)
	expansion = strings.TrimSpace(expansion)
	if trigger == "" || expansion == "" {
		return fmt.Errorf("trigger and expansion must not be empty")
	}
	if a.config.Aliases == nil {
		a.config.Aliases = make(map[string]string)
	}
	a.config.Aliases[strings.ToLower(trigger)] = expansion
	return a.saveConfig()
}

// DeleteAlias removes an alias by trigger.
func (a *App) DeleteAlias(trigger string) error {
	if a.config.Aliases != nil {
		delete(a.config.Aliases, trigger)
	}
	return a.saveConfig()
}

// TogglePinned pins an item if not already pinned, or unpins it if it is.
// Returns true if the item is now pinned, false if it was unpinned.
func (a *App) TogglePinned(id string) bool {
	for i, p := range a.config.PinnedItems {
		if p == id {
			a.config.PinnedItems = append(a.config.PinnedItems[:i], a.config.PinnedItems[i+1:]...)
			_ = a.saveConfig()
			return false
		}
	}
	a.config.PinnedItems = append(a.config.PinnedItems, id)
	_ = a.saveConfig()
	return true
}

func (a *App) ReindexFiles() {
	a.fileIdx.Reindex()
}

func (a *App) CancelIndex() {
	a.fileIdx.CancelIndex()
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

func (a *App) searchDirs(query string) []SearchResult {
	if len(query) < 2 || a.config.DisableFolderIndex {
		return nil
	}

	status := a.fileIdx.Status()
	if status.State != "ready" {
		return nil
	}

	dirResults := a.fileIdx.SearchDirs(query)
	limit := a.maxResults() / 2
	if limit < 3 {
		limit = 3
	}
	if len(dirResults) > limit {
		dirResults = dirResults[:limit]
	}

	var results []SearchResult
	for _, d := range dirResults {
		results = append(results, SearchResult{
			ID:       "dir-open:" + d.Path,
			Title:    d.Name,
			Subtitle: prettifyPath(d.Path),
			Icon:     "",
			Category: "Folders",
			Path:     d.Path,
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
		if slices.Contains(a.config.PinnedItems, app.Name) {
			usageScores[i] += 100
		}
	}

	matches := search.Fuzzy(query, names, usageScores)

	var results []SearchResult
	limit := min(len(matches), a.maxResults())

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
	var results []SearchResult

	// Pinned items first
	pinnedSet := make(map[string]bool)
	for _, pinnedID := range a.config.PinnedItems {
		pinnedSet[pinnedID] = true
		for _, app := range allApps {
			if app.Name == pinnedID {
				subtitle := "Application"
				if !app.IsLnk {
					subtitle = prettifyPath(app.Path)
				}
				results = append(results, SearchResult{
					ID:       app.Name,
					Title:    app.Name,
					Subtitle: subtitle,
					Category: "Pinned",
					Path:     app.Path,
				})
				break
			}
		}
	}

	names := a.scanner.Names()
	usageScores := make([]int, len(allApps))
	for i, app := range allApps {
		usageScores[i] = a.usage.Score(app.Name)
	}
	matches := search.Fuzzy("", names, usageScores)

	count := 6
	added := 0
	for _, match := range matches {
		if added >= count {
			break
		}
		app := allApps[match.Index]
		if pinnedSet[app.Name] {
			continue // already shown above
		}
		category := "Suggested"
		if a.usage.Score(app.Name) > 0 {
			category = "Recent"
		}
		subtitle := "Application"
		if !app.IsLnk {
			subtitle = prettifyPath(app.Path)
		}
		results = append(results, SearchResult{
			ID:       app.Name,
			Title:    app.Name,
			Subtitle: subtitle,
			Category: category,
			Path:     app.Path,
		})
		added++
	}

	return results
}

// searchPath handles path-browser mode. Triggered by queries starting with ~
// or any absolute path prefix (C:\, /, \\, etc.). The query is parsed as a
// filesystem path; the final segment (after the last separator) is used as a
// filter against the parent directory's contents.
//
//	~             → list home dir
//	~/doc         → list home dir, entries containing "doc"
//	~/Documents/  → list ~/Documents/
//	C:\Users\     → list C:\Users\
//	C:\Users\foo  → list C:\Users\, entries containing "foo"
func (a *App) searchPath(query string) []SearchResult {
	home, _ := os.UserHomeDir()

	// Expand ~ to the home directory.
	expanded := filepath.FromSlash(query)
	if strings.HasPrefix(expanded, "~") {
		expanded = home + expanded[1:]
	}

	// Determine searchDir and filter:
	// - If the query ends with a separator, list the directory as-is.
	// - Otherwise, the last path segment is the filter and its parent is the dir.
	var searchDir, filter string
	last := expanded[len(expanded)-1]
	if last == filepath.Separator || last == '/' {
		searchDir = filepath.Clean(expanded)
		filter = ""
	} else {
		searchDir = filepath.Dir(expanded)
		filter = filepath.Base(expanded)
		// filepath.Dir of a bare drive like "C:" returns "C:"; treat as root.
		if searchDir == "." {
			searchDir = home
		}
	}

	entries, err := os.ReadDir(searchDir)
	if err != nil {
		return []SearchResult{{
			ID:       "no-results",
			Title:    "Directory not found",
			Subtitle: prettifyPath(searchDir),
			Category: "Files",
		}}
	}

	filterLower := strings.ToLower(filter)
	limit := a.maxResults() * 2

	// Dirs first, then files.
	var dirs, fileResults []SearchResult
	for _, entry := range entries {
		if len(dirs)+len(fileResults) >= limit {
			break
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue // skip hidden entries
		}
		if filterLower != "" && !strings.Contains(strings.ToLower(name), filterLower) {
			continue
		}
		path := filepath.Join(searchDir, name)
		if entry.IsDir() {
			dirs = append(dirs, SearchResult{
				ID:       "dir-open:" + path,
				Title:    name,
				Subtitle: prettifyPath(path),
				Category: "Folders",
				Path:     path,
			})
		} else {
			fileResults = append(fileResults, SearchResult{
				ID:       "file-open:" + path,
				Title:    name,
				Subtitle: prettifyPath(searchDir),
				Category: "Files",
				Path:     path,
			})
		}
	}

	results := append(dirs, fileResults...)
	if len(results) == 0 {
		return []SearchResult{{
			ID:       "no-results",
			Title:    "No matches in " + prettifyPath(searchDir),
			Subtitle: "Try a different name",
			Category: "Files",
		}}
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

// isAbsPath returns true if s looks like an absolute filesystem path on any
// supported platform: Windows drive paths (C:\, C:/), UNC paths (\\server\),
// and Unix-style absolute paths (/home/...).
func isAbsPath(s string) bool {
	if len(s) >= 2 && s[1] == ':' {
		return true // Windows drive: C:\ or C:/
	}
	if strings.HasPrefix(s, `\\`) || strings.HasPrefix(s, "//") {
		return true // UNC / network path
	}
	if strings.HasPrefix(s, "/") {
		return true // Unix absolute path
	}
	return false
}
