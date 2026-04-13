package search

import (
	"testing"
)

func TestFuzzy_EmptyQuery_ReturnsAllTargetsSortedByUsage(t *testing.T) {
	targets := []string{"alpha", "beta", "gamma"}
	scores := []int{0, 10, 5}
	results := Fuzzy("", targets, scores)

	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}
	// beta has highest usage score (10 * 100 = 1000), should be first
	if results[0].Index != 1 {
		t.Errorf("expected beta (index 1) first, got index %d", results[0].Index)
	}
}

func TestFuzzy_ExactMatch_ScoresHighest(t *testing.T) {
	targets := []string{"Firefox", "Fireplace", "Fire HD"}
	scores := []int{0, 0, 0}
	results := Fuzzy("firefox", targets, scores)

	if len(results) == 0 {
		t.Fatal("expected results, got none")
	}
	if results[0].Index != 0 {
		t.Errorf("expected Firefox (index 0) first, got index %d", results[0].Index)
	}
	if results[0].Score < 10000 {
		t.Errorf("expected exact match score >= 10000, got %d", results[0].Score)
	}
}

func TestFuzzy_PrefixMatch_ScoresAbove5000(t *testing.T) {
	targets := []string{"Firefox", "NotFirefox"}
	scores := []int{0, 0}
	results := Fuzzy("fire", targets, scores)

	found := false
	for _, r := range results {
		if r.Index == 0 && r.Score >= 5000 {
			found = true
		}
	}
	if !found {
		t.Error("expected Firefox to have prefix score >= 5000")
	}
}

func TestFuzzy_ContainsMatch_ScoresAbove2000(t *testing.T) {
	targets := []string{"NotFirefox"}
	scores := []int{0}
	results := Fuzzy("fire", targets, scores)

	if len(results) == 0 {
		t.Fatal("expected a match for 'fire' in 'NotFirefox'")
	}
	if results[0].Score < 2000 {
		t.Errorf("expected contains score >= 2000, got %d", results[0].Score)
	}
}

func TestFuzzy_NoMatch_ReturnsEmpty(t *testing.T) {
	targets := []string{"Firefox", "Chrome", "Safari"}
	scores := []int{0, 0, 0}
	results := Fuzzy("zzz", targets, scores)

	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

func TestFuzzy_UsageScore_BoostsMatch(t *testing.T) {
	// "al" prefix-matches "alpha"; give alpha a large usage score so it
	// dominates even if another target would normally rank higher.
	targets := []string{"alpha", "almond"}
	scores := []int{1000, 0}
	results := Fuzzy("al", targets, scores)

	if len(results) == 0 {
		t.Fatal("expected results")
	}
	// alpha (index 0) should win due to usage boost
	if results[0].Index != 0 {
		t.Errorf("expected alpha (index 0) first due to usage boost, got index %d", results[0].Index)
	}
}

func TestFuzzy_ResultsSortedByScoreDescending(t *testing.T) {
	targets := []string{"abcdef", "ab", "abc"}
	scores := []int{0, 0, 0}
	results := Fuzzy("ab", targets, scores)

	for i := 1; i < len(results); i++ {
		if results[i].Score > results[i-1].Score {
			t.Errorf("results not sorted: score[%d]=%d > score[%d]=%d",
				i, results[i].Score, i-1, results[i-1].Score)
		}
	}
}

func TestFuzzy_AcronymMatch_ScoresAbove3000(t *testing.T) {
	targets := []string{"Visual Studio Code"}
	scores := []int{0}
	results := Fuzzy("vsc", targets, scores)

	if len(results) == 0 {
		t.Fatal("expected acronym match for 'vsc' in 'Visual Studio Code'")
	}
	if results[0].Score < 3000 {
		t.Errorf("expected acronym score >= 3000, got %d", results[0].Score)
	}
}

func TestFuzzy_CaseInsensitive(t *testing.T) {
	targets := []string{"Google Chrome"}
	scores := []int{0}

	upper := Fuzzy("CHROME", targets, scores)
	lower := Fuzzy("chrome", targets, scores)

	if len(upper) == 0 || len(lower) == 0 {
		t.Fatal("expected matches for both cases")
	}
	if upper[0].Score != lower[0].Score {
		t.Errorf("case should not affect score: upper=%d lower=%d", upper[0].Score, lower[0].Score)
	}
}

func TestFuzzy_EmptyTargets_ReturnsEmpty(t *testing.T) {
	results := Fuzzy("anything", []string{}, []int{})
	if len(results) != 0 {
		t.Errorf("expected empty results for empty targets, got %d", len(results))
	}
}
