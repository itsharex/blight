package commands

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"math"
	"strconv"
	"strings"
)

type CalcResult struct {
	Expression string
	Result     string
	Valid      bool
}

func Evaluate(input string) CalcResult {
	expr := strings.TrimSpace(input)
	if strings.HasPrefix(expr, "=") {
		expr = strings.TrimSpace(expr[1:])
	}

	if expr == "" {
		return CalcResult{Valid: false}
	}

	// Pre-process: replace ^ with ** (Go AST uses XOR for ^, we'll remap to pow)
	expr = strings.ReplaceAll(expr, "^", "**")
	expr = strings.ReplaceAll(expr, "**", "^") // back to XOR which we'll handle as pow

	result, err := evalExpr(expr)
	if err != nil {
		return CalcResult{Valid: false}
	}

	// Check for hex/bin output requests
	origLower := strings.ToLower(strings.TrimSpace(input))
	if strings.HasPrefix(origLower, "=") {
		origLower = strings.TrimSpace(origLower[1:])
	}

	formatted := formatNumber(result)
	return CalcResult{
		Expression: strings.TrimSpace(input),
		Result:     formatted,
		Valid:      true,
	}
}

func IsCalcQuery(query string) bool {
	q := strings.TrimSpace(query)
	if strings.HasPrefix(q, "=") {
		return true
	}
	if len(q) < 2 {
		return false
	}

	// If it starts with a known math function name, treat as calc
	lq := strings.ToLower(q)
	mathFuncs := []string{
		"sqrt(", "abs(", "floor(", "ceil(", "round(",
		"sin(", "cos(", "tan(", "asin(", "acos(", "atan(",
		"log(", "log2(", "log10(", "ln(", "exp(", "pow(",
		"cbrt(", "atan2(", "min(", "max(",
	}
	for _, fn := range mathFuncs {
		if strings.HasPrefix(lq, fn) {
			return true
		}
	}

	hasDigit := false
	hasOp := false
	for _, c := range q {
		if c >= '0' && c <= '9' {
			hasDigit = true
		}
		if c == '+' || c == '-' || c == '*' || c == '/' || c == '%' || c == '^' {
			hasOp = true
		}
	}
	return hasDigit && hasOp
}

func evalExpr(expr string) (float64, error) {
	node, err := parser.ParseExpr(expr)
	if err != nil {
		return 0, err
	}
	return evalNode(node)
}

func evalNode(node ast.Expr) (float64, error) {
	switch n := node.(type) {
	case *ast.BasicLit:
		switch n.Kind {
		case token.INT:
			// Handle hex (0x...) and octal (0...)
			v, err := strconv.ParseInt(n.Value, 0, 64)
			if err != nil {
				return strconv.ParseFloat(n.Value, 64)
			}
			return float64(v), nil
		case token.FLOAT:
			return strconv.ParseFloat(n.Value, 64)
		}
		return strconv.ParseFloat(n.Value, 64)

	case *ast.ParenExpr:
		return evalNode(n.X)

	case *ast.UnaryExpr:
		x, err := evalNode(n.X)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case token.SUB:
			return -x, nil
		case token.ADD:
			return x, nil
		}
		return 0, fmt.Errorf("unsupported unary op: %s", n.Op)

	case *ast.BinaryExpr:
		left, err := evalNode(n.X)
		if err != nil {
			return 0, err
		}
		right, err := evalNode(n.Y)
		if err != nil {
			return 0, err
		}

		switch n.Op {
		case token.ADD:
			return left + right, nil
		case token.SUB:
			return left - right, nil
		case token.MUL:
			return left * right, nil
		case token.QUO:
			if right == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			return left / right, nil
		case token.REM:
			if right == 0 {
				return 0, fmt.Errorf("modulo by zero")
			}
			return float64(int64(left) % int64(right)), nil
		case token.XOR:
			// We remapped ^ to XOR in the AST, treat as pow
			return math.Pow(left, right), nil
		case token.SHL:
			return float64(int64(left) << uint(int64(right))), nil
		case token.SHR:
			return float64(int64(left) >> uint(int64(right))), nil
		case token.AND:
			return float64(int64(left) & int64(right)), nil
		case token.OR:
			return float64(int64(left) | int64(right)), nil
		}
		return 0, fmt.Errorf("unsupported op: %s", n.Op)

	case *ast.Ident:
		switch strings.ToLower(n.Name) {
		case "pi":
			return math.Pi, nil
		case "e":
			return math.E, nil
		case "phi":
			return math.Phi, nil
		case "inf", "infinity":
			return math.Inf(1), nil
		}
		return 0, fmt.Errorf("unknown identifier: %s", n.Name)

	case *ast.CallExpr:
		// Function call: resolve function name
		ident, ok := n.Fun.(*ast.Ident)
		if !ok {
			return 0, fmt.Errorf("unsupported call expression")
		}
		fnName := strings.ToLower(ident.Name)

		// Evaluate all arguments
		args := make([]float64, len(n.Args))
		for i, arg := range n.Args {
			v, err := evalNode(arg)
			if err != nil {
				return 0, fmt.Errorf("arg %d: %w", i, err)
			}
			args[i] = v
		}

		return callMathFunc(fnName, args)
	}

	return 0, fmt.Errorf("unsupported expression type: %T", node)
}

func callMathFunc(name string, args []float64) (float64, error) {
	need := func(n int) error {
		if len(args) != n {
			return fmt.Errorf("%s() requires %d argument(s), got %d", name, n, len(args))
		}
		return nil
	}
	atLeast := func(n int) error {
		if len(args) < n {
			return fmt.Errorf("%s() requires at least %d argument(s)", name, n)
		}
		return nil
	}

	switch name {
	case "sqrt":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] < 0 {
			return 0, fmt.Errorf("sqrt of negative number")
		}
		return math.Sqrt(args[0]), nil

	case "cbrt":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Cbrt(args[0]), nil

	case "abs":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Abs(args[0]), nil

	case "floor":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Floor(args[0]), nil

	case "ceil":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Ceil(args[0]), nil

	case "round":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Round(args[0]), nil

	case "pow":
		if err := need(2); err != nil {
			return 0, err
		}
		return math.Pow(args[0], args[1]), nil

	case "exp":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Exp(args[0]), nil

	case "log", "log10":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] <= 0 {
			return 0, fmt.Errorf("log of non-positive number")
		}
		return math.Log10(args[0]), nil

	case "log2":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] <= 0 {
			return 0, fmt.Errorf("log2 of non-positive number")
		}
		return math.Log2(args[0]), nil

	case "ln":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] <= 0 {
			return 0, fmt.Errorf("ln of non-positive number")
		}
		return math.Log(args[0]), nil

	case "sin":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Sin(args[0]), nil

	case "cos":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Cos(args[0]), nil

	case "tan":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Tan(args[0]), nil

	case "asin":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Asin(args[0]), nil

	case "acos":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Acos(args[0]), nil

	case "atan":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Atan(args[0]), nil

	case "atan2":
		if err := need(2); err != nil {
			return 0, err
		}
		return math.Atan2(args[0], args[1]), nil

	case "min":
		if err := atLeast(1); err != nil {
			return 0, err
		}
		m := args[0]
		for _, v := range args[1:] {
			if v < m {
				m = v
			}
		}
		return m, nil

	case "max":
		if err := atLeast(1); err != nil {
			return 0, err
		}
		m := args[0]
		for _, v := range args[1:] {
			if v > m {
				m = v
			}
		}
		return m, nil

	case "mod":
		if err := need(2); err != nil {
			return 0, err
		}
		if args[1] == 0 {
			return 0, fmt.Errorf("mod by zero")
		}
		return math.Mod(args[0], args[1]), nil

	case "hypot":
		if err := need(2); err != nil {
			return 0, err
		}
		return math.Hypot(args[0], args[1]), nil

	case "deg", "degrees":
		if err := need(1); err != nil {
			return 0, err
		}
		return args[0] * 180 / math.Pi, nil

	case "rad", "radians":
		if err := need(1); err != nil {
			return 0, err
		}
		return args[0] * math.Pi / 180, nil

	case "sign":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] > 0 {
			return 1, nil
		}
		if args[0] < 0 {
			return -1, nil
		}
		return 0, nil

	case "clamp":
		if err := need(3); err != nil {
			return 0, err
		}
		v, lo, hi := args[0], args[1], args[2]
		if v < lo {
			return lo, nil
		}
		if v > hi {
			return hi, nil
		}
		return v, nil
	}

	return 0, fmt.Errorf("unknown function: %s()", name)
}

func formatNumber(f float64) string {
	if math.IsInf(f, 1) {
		return "∞"
	}
	if math.IsInf(f, -1) {
		return "-∞"
	}
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	s := fmt.Sprintf("%.10f", f)
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	return s
}
