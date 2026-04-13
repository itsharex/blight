.PHONY: all build test lint fmt fmt-check help \
        go-test go-lint go-fmt go-vet \
        fe-install fe-test fe-lint fe-fmt fe-fmt-check

# ── Defaults ────────────────────────────────────────────────────────────────
all: fmt lint test build

# ── Go targets ───────────────────────────────────────────────────────────────
go-test:
	go test ./...

go-lint:
	golangci-lint run

go-fmt:
	gofmt -l -w .

go-vet:
	go vet ./...

# ── Frontend targets ─────────────────────────────────────────────────────────
fe-install:
	cd frontend && pnpm install

fe-test:
	cd frontend && pnpm test

fe-lint:
	cd frontend && pnpm lint

fe-fmt:
	cd frontend && pnpm format

fe-fmt-check:
	cd frontend && pnpm format:check

# ── Combined targets ─────────────────────────────────────────────────────────
test: go-test fe-test

lint: go-vet go-lint fe-lint

fmt: go-fmt fe-fmt

fmt-check: fe-fmt-check

build:
	wails build

# ── Help ─────────────────────────────────────────────────────────────────────
help:
	@printf "Usage: make [target]\n\n"
	@printf "  test         Run all tests (Go + Frontend)\n"
	@printf "  lint         Run all linters (Go + Frontend)\n"
	@printf "  fmt          Format all code (Go + Frontend)\n"
	@printf "  fmt-check    Check formatting without writing\n"
	@printf "  build        Build the application via Wails\n"
	@printf "  all          fmt + lint + test + build\n"
	@printf "\n  go-test / go-lint / go-fmt / go-vet\n"
	@printf "  fe-test / fe-lint / fe-fmt / fe-fmt-check / fe-install\n"
