package files

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"blight/internal/search"
)

const maxIndexFiles = 500_000

type FileEntry struct {
	Name string
	Path string
	Dir  string
	Ext  string
	Size int64
}

type IndexStatus struct {
	State   string `json:"state"`
	Message string `json:"message"`
	Count   int    `json:"count"`
	Total   int    `json:"total"`
}

type FileIndex struct {
	mu          sync.RWMutex
	files       []FileEntry
	names       []string
	status      atomic.Value
	lastIndexed atomic.Value // stores time.Time
	cancelFn    atomic.Value // stores context.CancelFunc
	onStatus    func(IndexStatus)
	customDirs  []string // user-configured extra scan dirs (from config.IndexDirs)
}

func NewFileIndex(customDirs []string, onStatus func(IndexStatus)) *FileIndex {
	idx := &FileIndex{
		onStatus:   onStatus,
		customDirs: customDirs,
	}
	idx.status.Store(IndexStatus{State: "idle", Message: "Not indexed"})
	return idx
}

func (idx *FileIndex) stopCurrent() {
	if fn, ok := idx.cancelFn.Load().(context.CancelFunc); ok && fn != nil {
		fn()
	}
}

func (idx *FileIndex) Start() {
	idx.stopCurrent()
	ctx, cancel := context.WithCancel(context.Background())
	idx.cancelFn.Store(cancel)
	go idx.buildIndex(ctx)
}

func (idx *FileIndex) Reindex() {
	idx.stopCurrent()
	ctx, cancel := context.WithCancel(context.Background())
	idx.cancelFn.Store(cancel)
	go idx.buildIndex(ctx)
}

func (idx *FileIndex) CancelIndex() {
	idx.stopCurrent()
	idx.setStatus(IndexStatus{State: "idle", Message: "Indexing cancelled"})
}

func (idx *FileIndex) UpdateDirs(dirs []string) {
	idx.mu.Lock()
	idx.customDirs = dirs
	idx.mu.Unlock()
}

func (idx *FileIndex) IsStale(maxAge time.Duration) bool {
	t, ok := idx.lastIndexed.Load().(time.Time)
	return !ok || t.IsZero() || time.Since(t) > maxAge
}

func (idx *FileIndex) ClearIndex() {
	idx.stopCurrent()
	idx.mu.Lock()
	idx.files = nil
	idx.names = nil
	idx.mu.Unlock()
	idx.setStatus(IndexStatus{State: "idle", Message: "Index cleared"})
}

func (idx *FileIndex) Status() IndexStatus {
	return idx.status.Load().(IndexStatus)
}

func (idx *FileIndex) Files() []FileEntry {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	result := make([]FileEntry, len(idx.files))
	copy(result, idx.files)
	return result
}

func (idx *FileIndex) Names() []string {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	result := make([]string, len(idx.names))
	copy(result, idx.names)
	return result
}

func (idx *FileIndex) setStatus(s IndexStatus) {
	idx.status.Store(s)
	if idx.onStatus != nil {
		idx.onStatus(s)
	}
}

func (idx *FileIndex) buildIndex(ctx context.Context) {
	idx.setStatus(IndexStatus{State: "indexing", Message: "Scanning files..."})
	idx.manualIndex(ctx)
}

func (idx *FileIndex) manualIndex(ctx context.Context) {
	home, _ := os.UserHomeDir()
	scanDirs := []string{
		filepath.Join(home, "Desktop"),
		filepath.Join(home, "Documents"),
		filepath.Join(home, "Downloads"),
		filepath.Join(home, "Pictures"),
		filepath.Join(home, "Videos"),
		filepath.Join(home, "Music"),
	}

	if projects := filepath.Join(home, "Projects"); dirExists(projects) {
		scanDirs = append(scanDirs, projects)
	}
	if code := filepath.Join(home, "code"); dirExists(code) {
		scanDirs = append(scanDirs, code)
	}

	// Add user-configured extra directories
	seen := make(map[string]bool)
	for _, d := range scanDirs {
		seen[strings.ToLower(d)] = true
	}
	idx.mu.RLock()
	customDirs := append([]string(nil), idx.customDirs...)
	idx.mu.RUnlock()
	for _, d := range customDirs {
		if d != "" && !seen[strings.ToLower(d)] && dirExists(d) {
			scanDirs = append(scanDirs, d)
			seen[strings.ToLower(d)] = true
		}
	}

	var allFiles []FileEntry
	count := 0
	total := 0

	for _, dir := range scanDirs {
		total += estimateCount(dir)
	}
	if total == 0 {
		total = 1
	}

	start := time.Now()
	lastUpdate := time.Now()

	for _, dir := range scanDirs {
		if ctx.Err() != nil {
			idx.setStatus(IndexStatus{State: "idle", Message: "Indexing cancelled"})
			return
		}

		dirName := filepath.Base(dir)
		filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return filepath.SkipAll
			}
			if err != nil {
				return nil
			}

			name := d.Name()

			if d.IsDir() {
				if shouldSkipDir(name) {
					return filepath.SkipDir
				}
				return nil
			}

			count++

			if count >= maxIndexFiles {
				return filepath.SkipAll
			}

			if time.Since(lastUpdate) > 200*time.Millisecond {
				lastUpdate = time.Now()
				idx.setStatus(IndexStatus{
					State:   "indexing",
					Message: "Scanning " + dirName + "...",
					Count:   count,
					Total:   total,
				})
			}

			info, err := d.Info()
			size := int64(0)
			if err == nil {
				size = info.Size()
			}

			allFiles = append(allFiles, FileEntry{
				Name: name,
				Path: path,
				Dir:  filepath.Dir(path),
				Ext:  strings.ToLower(filepath.Ext(name)),
				Size: size,
			})

			return nil
		})
	}

	if ctx.Err() != nil {
		idx.setStatus(IndexStatus{State: "idle", Message: "Indexing cancelled"})
		return
	}

	names := make([]string, len(allFiles))
	for i, f := range allFiles {
		names[i] = f.Name
	}

	idx.mu.Lock()
	idx.files = allFiles
	idx.names = names
	idx.mu.Unlock()

	elapsed := time.Since(start).Round(time.Millisecond)
	msg := fmt.Sprintf("%d files indexed in %s", count, elapsed)
	idx.lastIndexed.Store(time.Now())
	idx.setStatus(IndexStatus{
		State:   "ready",
		Message: msg,
		Count:   count,
		Total:   count,
	})
}

// SearchFiles performs fuzzy matching against the local index filename.
func (idx *FileIndex) SearchFiles(query string) []FileEntry {
	if query == "" {
		return nil
	}

	idx.mu.RLock()
	names := idx.names
	allFiles := idx.files
	idx.mu.RUnlock()

	emptyScores := make([]int, len(names))
	matches := search.Fuzzy(strings.ToLower(query), names, emptyScores)

	var results []FileEntry
	for _, m := range matches {
		if len(results) >= 15 {
			break
		}
		results = append(results, allFiles[m.Index])
	}

	return results
}

func shouldSkipDir(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	skip := map[string]bool{
		"node_modules": true, "__pycache__": true, "vendor": true,
		"$RECYCLE.BIN": true, "System Volume Information": true,
		"AppData": true, "cache": true, "Cache": true,
		"dist": true, "build": true, "target": true,
		"venv": true, ".venv": true, "env": true,
	}
	return skip[name]
}

func estimateCount(dir string) int {
	count := 0
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	for _, entry := range entries {
		if entry.IsDir() {
			count += 500
		} else {
			count++
		}
	}
	return count
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
