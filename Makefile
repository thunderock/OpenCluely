# OpenCluely developer commands (FND-03).
# The four target names are fixed by convention — do not rename or add.
#
# Ordering note: on a clean checkout run `make setup` (or `make setup-dev`)
# BEFORE `make lint` or `make run_tests` — lint needs ESLint (a devDependency)
# installed first.

.PHONY: setup setup-dev run_tests lint

# Runtime deps + Electron + the eslint/globals devDeps, reproducible from the
# committed package-lock.json.
setup:
	npm ci

# Dev/test/lint tooling comes from the same `npm ci`; kept as a distinct target
# per the fixed convention, with `setup` as a prerequisite so a clean checkout
# is provisioned.
setup-dev: setup

# Pure-logic + supervisor suites via Node's built-in runner (no Electron).
# The single-* glob is shell-expanded and portable to Node 20 (CI) and newer;
# it runs only test/*.test.js, so test/fixtures/** is never executed as a test.
run_tests:
	node --test test/*.test.js

# Error-only lint gate — eslint exits non-zero on any error.
lint:
	npx eslint .
