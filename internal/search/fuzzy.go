package search

import (
	"strings"
	"unicode"
)

// Match is a single scored result from a Fuzzy search.
type Match struct {
	Score int
	Index int
}

func Fuzzy(query string, targets []string, usageScores []int) []Match {
	if query == "" {
		matches := make([]Match, len(targets))
		for i := range targets {
			matches[i] = Match{Score: usageScores[i] * 100, Index: i}
		}
		sortByScore(matches)
		return matches
	}

	queryNorm := strings.ToLower(strings.TrimSpace(query))
	var matches []Match

	const minScore = 50

	for i, target := range targets {
		targetNorm := strings.ToLower(target)
		s := score(queryNorm, targetNorm)
		if s >= minScore {
			s += usageScores[i] * 100
			matches = append(matches, Match{Score: s, Index: i})
		}
	}

	sortByScore(matches)
	return matches
}

func score(query, target string) int {
	if target == query {
		return 10000
	}
	if strings.HasPrefix(target, query) {
		return 5000 + len(query)*10
	}
	if strings.Contains(target, query) {
		return 2000 + len(query)*5
	}

	if s := acronymScore(query, target); s > 0 {
		return s
	}

	terms := strings.Fields(query)
	if len(terms) > 1 {
		if s := multiTermScore(terms, target); s > 0 {
			return s
		}
	}

	return fuzzyScore(query, target)
}

func acronymScore(query, target string) int {
	if len(query) == 0 || len(target) == 0 {
		return 0
	}

	type acChar struct {
		ch  byte
		pos int
	}

	var acronym []acChar
	for i := 0; i < len(target); i++ {
		ch := target[i]
		isAcronym := i == 0
		if !isAcronym && i > 0 {
			prev := target[i-1]
			isAcronym = prev == ' ' || prev == '-' || prev == '_' || prev == '.' || prev == '/' || prev == '\\'
		}
		if isAcronym {
			acronym = append(acronym, acChar{ch: ch, pos: i})
		}
	}

	if len(acronym) < len(query) {
		return 0
	}

	// Check query is a subsequence of acronym chars
	qi := 0
	matchCount := 0
	for _, ac := range acronym {
		if qi < len(query) && ac.ch == query[qi] {
			qi++
			matchCount++
		}
	}

	if qi < len(query) {
		return 0
	}

	// Perfect acronym (all initials consumed)
	base := 3000
	if matchCount == len(acronym) {
		base = 4000
	}
	return base + len(query)*15
}

func multiTermScore(terms []string, target string) int {
	totalScore := 0
	for _, term := range terms {
		s := singleTermBestScore(term, target)
		if s == 0 {
			return 0 // all terms must match
		}
		totalScore += s
	}
	// Blend: average per-term score, then bonus for multi-word precision
	avg := totalScore / len(terms)
	return avg + len(terms)*50
}

func singleTermBestScore(term, target string) int {
	if strings.HasPrefix(target, term) {
		return 5000 + len(term)*10
	}
	if strings.Contains(target, term) {
		return 2000 + len(term)*5
	}
	if s := acronymScore(term, target); s > 0 {
		return s
	}
	return fuzzyScore(term, target)
}

func fuzzyScore(query, target string) int {
	if len(query) == 0 {
		return 0
	}

	queryIndex := 0
	firstMatchIndex := -1
	lastMatchIndex := 0
	consecutive := 0
	maxConsecutive := 0
	wordBoundaryBonus := 0
	consecutiveBonus := 0

	for ti := 0; ti < len(target) && queryIndex < len(query); ti++ {
		if target[ti] == query[queryIndex] {
			if firstMatchIndex == -1 {
				firstMatchIndex = ti
			}
			lastMatchIndex = ti
			consecutive++
			if consecutive > maxConsecutive {
				maxConsecutive = consecutive
			}
			// consecutive run bonus
			if consecutive > 1 {
				consecutiveBonus += consecutive * 5
			}
			// first character at position 0
			if queryIndex == 0 && ti == 0 {
				wordBoundaryBonus += 50
			} else if ti > 0 && isWordBoundary(rune(target[ti-1])) {
				wordBoundaryBonus += 25
			}
			queryIndex++
		} else {
			consecutive = 0
		}
	}

	if queryIndex < len(query) {
		return 0 // not all query chars matched
	}

	matchSpan := lastMatchIndex - firstMatchIndex
	// Flow Launcher formula: higher score for earlier + tighter matches
	base := 100 * (len(query) + 1) / ((1 + firstMatchIndex) + (matchSpan + 1))

	// Length proximity bonus (target close in length to query)
	lengthDiff := len(target) - len(query)
	lengthBonus := 0
	switch {
	case lengthDiff <= 5:
		lengthBonus = 20
	case lengthDiff <= 10:
		lengthBonus = 10
	}

	return base + wordBoundaryBonus + consecutiveBonus + lengthBonus
}

func isWordBoundary(r rune) bool {
	return r == ' ' || r == '-' || r == '_' || r == '.' || r == '/' || r == '\\' || unicode.IsUpper(r)
}

func sortByScore(matches []Match) {
	// Insertion sort — fast enough for typical result sets (< 1000)
	for i := 1; i < len(matches); i++ {
		current := i
		for current > 0 && matches[current].Score > matches[current-1].Score {
			matches[current], matches[current-1] = matches[current-1], matches[current]
			current--
		}
	}
}
