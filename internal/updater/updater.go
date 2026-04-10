package updater

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/blang/semver"
)

// Release holds the information about a GitHub release.
type Release struct {
	Version string
	URL     string
	Notes   string
}

type Updater struct {
	repo string
}

func New(repo string) *Updater {
	return &Updater{repo: repo}
}

type ghRelease struct {
	TagName string    `json:"tag_name"`
	Body    string    `json:"body"`
	Assets  []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// CheckForUpdates fetches all releases from GitHub and returns the newest one
// whose version is greater than currentVersion (pre-releases included)
// that has an installer asset for the current OS build.
func (u *Updater) CheckForUpdates(currentVersion string) (*Release, bool, error) {
	cur, err := parseTolerant(currentVersion)
	if err != nil {
		return nil, false, fmt.Errorf("failed to parse current version %q: %w", currentVersion, err)
	}

	url := fmt.Sprintf("https://api.github.com/repos/%s/releases", u.repo)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "blight-updater")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("github api request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, false, fmt.Errorf("github api returned status %d", resp.StatusCode)
	}

	var releases []ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, false, fmt.Errorf("failed to decode releases: %w", err)
	}

	for _, rel := range releases {
		tag := strings.TrimPrefix(rel.TagName, "v")
		v, err := parseTolerant(tag)
		if err != nil {
			continue
		}
		if !v.GT(cur) {
			continue
		}
		// Find an installer asset matching the current OS build.
		for _, asset := range rel.Assets {
			name := strings.ToLower(asset.Name)
			if isInstallerAsset(name) {
				return &Release{
					Version: tag,
					URL:     asset.BrowserDownloadURL,
					Notes:   rel.Body,
				}, true, nil
			}
		}
	}

	return nil, false, nil
}

// ApplyUpdate downloads the matching installer and starts it.
func (u *Updater) ApplyUpdate(release *Release) error {
	return u.ApplyUpdateWithProgress(release, nil)
}

// ApplyUpdateWithProgress downloads the installer, calling onProgress(0-100) during download, then starts it.
func (u *Updater) ApplyUpdateWithProgress(release *Release, onProgress func(pct int)) error {
	tmp, err := os.MkdirTemp("", "blight-update-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}

	dest := filepath.Join(tmp, installerTempName())

	resp, err := http.Get(release.URL)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("failed to create installer file: %w", err)
	}

	var src io.Reader = resp.Body
	if onProgress != nil && resp.ContentLength > 0 {
		src = &progressReader{r: resp.Body, total: resp.ContentLength, onProgress: onProgress}
	}

	_, copyErr := io.Copy(f, src)
	f.Close()
	if copyErr != nil {
		return fmt.Errorf("download write failed: %w", copyErr)
	}

	cmd := installerCommand(dest)
	cmd.SysProcAttr = installerSysProcAttr()
	return cmd.Start()
}

type progressReader struct {
	r          io.Reader
	total      int64
	read       int64
	onProgress func(int)
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	pr.read += int64(n)
	pct := int(pr.read * 100 / pr.total)
	if pct > 100 {
		pct = 100
	}
	pr.onProgress(pct)
	return n, err
}

// parseTolerant parses a version string, stripping pre-release labels if needed.
func parseTolerant(v string) (semver.Version, error) {
	parsed, err := semver.ParseTolerant(v)
	if err == nil {
		return parsed, nil
	}
	// Strip pre-release suffix (e.g. "0.2.4-alpha" → "0.2.4")
	if idx := strings.IndexByte(v, '-'); idx != -1 {
		parsed, err2 := semver.ParseTolerant(v[:idx])
		if err2 == nil {
			return parsed, nil
		}
	}
	return semver.Version{}, err
}
