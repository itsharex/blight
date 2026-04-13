package commands

import (
	"testing"
)

func TestIsCalcQuery(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		// Explicit = prefix always counts
		{"=1+2", true},
		{"= 100 * 3", true},
		{"=pi", true},
		// Digit + operator combinations
		{"1+2", true},
		{"10*5", true},
		{"100-50", true},
		{"10/2", true},
		{"3^2", true},
		{"10%3", true},
		// Math function prefixes
		{"sqrt(4)", true},
		{"abs(-5)", true},
		{"floor(3.7)", true},
		{"sin(0)", true},
		{"log(100)", true},
		{"log2(8)", true},
		{"log10(100)", true},
		// Not calc queries
		{"hello", false},
		{"", false},
		{"a", false},
		{"12", false},  // digit but no operator
		{"+-*", false}, // operators but no digit
	}
	for _, tt := range tests {
		result := IsCalcQuery(tt.input)
		if result != tt.expected {
			t.Errorf("IsCalcQuery(%q) = %v, want %v", tt.input, result, tt.expected)
		}
	}
}

func TestEvaluate_BasicArithmetic(t *testing.T) {
	tests := []struct {
		input  string
		result string
	}{
		{"=1+2", "3"},
		{"=10-3", "7"},
		{"=2*6", "12"},
		{"=10/4", "2.5"},
		{"=10%3", "1"},
		{"=(1+2)*3", "9"},
		{"=-5", "-5"},
		{"=2^3", "8"}, // ^ treated as pow
	}
	for _, tt := range tests {
		r := Evaluate(tt.input)
		if !r.Valid {
			t.Errorf("Evaluate(%q): expected valid result, got invalid", tt.input)
			continue
		}
		if r.Result != tt.result {
			t.Errorf("Evaluate(%q).Result = %q, want %q", tt.input, r.Result, tt.result)
		}
	}
}

func TestEvaluate_MathFunctions(t *testing.T) {
	tests := []struct {
		input  string
		result string
	}{
		{"=sqrt(16)", "4"},
		{"=abs(-7)", "7"},
		{"=floor(3.9)", "3"},
		{"=ceil(3.1)", "4"},
		{"=round(3.5)", "4"},
		{"=min(5, 2, 8)", "2"},
		{"=max(5, 2, 8)", "8"},
		{"=pow(2, 10)", "1024"},
		{"=clamp(5, 1, 10)", "5"},
		{"=clamp(0, 1, 10)", "1"},
		{"=clamp(15, 1, 10)", "10"},
		{"=sign(-3)", "-1"},
		{"=sign(3)", "1"},
		{"=sign(0)", "0"},
		{"=cbrt(27)", "3"},
		{"=hypot(3, 4)", "5"},
	}
	for _, tt := range tests {
		r := Evaluate(tt.input)
		if !r.Valid {
			t.Errorf("Evaluate(%q): expected valid result, got invalid", tt.input)
			continue
		}
		if r.Result != tt.result {
			t.Errorf("Evaluate(%q).Result = %q, want %q", tt.input, r.Result, tt.result)
		}
	}
}

func TestEvaluate_Constants(t *testing.T) {
	tests := []struct {
		input string
	}{
		{"=pi"},
		{"=e"},
		{"=phi"},
	}
	for _, tt := range tests {
		r := Evaluate(tt.input)
		if !r.Valid {
			t.Errorf("Evaluate(%q): expected valid result for constant", tt.input)
		}
		if r.Result == "" {
			t.Errorf("Evaluate(%q): expected non-empty result", tt.input)
		}
	}
}

func TestEvaluate_Invalid(t *testing.T) {
	invalid := []string{
		"",
		"hello world",
		"=1/0",
		"=sqrt(-1)",
		"=log(0)",
		"=log(-5)",
		"=unknown_func(1)",
	}
	for _, input := range invalid {
		r := Evaluate(input)
		if r.Valid {
			t.Errorf("Evaluate(%q): expected invalid, got valid with result %q", input, r.Result)
		}
	}
}

func TestEvaluate_ExpressionPreserved(t *testing.T) {
	r := Evaluate("=1+2")
	if r.Expression != "=1+2" {
		t.Errorf("Expression field: got %q, want %q", r.Expression, "=1+2")
	}
}

func TestEvaluate_WithoutEqualPrefix(t *testing.T) {
	// Expressions without = prefix should still evaluate
	r := Evaluate("1+2")
	if !r.Valid {
		t.Error("Evaluate(\"1+2\"): expected valid result without = prefix")
	}
	if r.Result != "3" {
		t.Errorf("Evaluate(\"1+2\").Result = %q, want \"3\"", r.Result)
	}
}

func TestEvaluate_BitwiseOps(t *testing.T) {
	tests := []struct {
		input  string
		result string
	}{
		{"=12 & 10", "8"},  // 1100 & 1010 = 1000
		{"=12 | 10", "14"}, // 1100 | 1010 = 1110
		{"=1 << 4", "16"},  // shift left
		{"=16 >> 2", "4"},  // shift right
	}
	for _, tt := range tests {
		r := Evaluate(tt.input)
		if !r.Valid {
			t.Errorf("Evaluate(%q): expected valid, got invalid", tt.input)
			continue
		}
		if r.Result != tt.result {
			t.Errorf("Evaluate(%q).Result = %q, want %q", tt.input, r.Result, tt.result)
		}
	}
}
