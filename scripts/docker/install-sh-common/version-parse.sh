#!/usr/bin/env bash
# Shared by the installer smoke images (install-sh-smoke, install-sh-nonroot,
# install-sh-e2e). Sourced, never executed.
#
# `openclaw --version` has two legitimate output shapes:
#   - "OpenClaw <semver> (<sha>)" / "OpenClaw <semver>": the published CLI since
#     upstream openclaw/openclaw#39712 (2026-03-08) added the build commit.
#   - "<semver>": this fork's CLI and every release published before #39712,
#     which the upgrade path still preinstalls.
# The whole line must match one of those shapes. Anything else (an error
# message, a banner, a different product name) is rejected rather than having
# a version-looking substring fished out of it.

OPENCLAW_SEMVER_PATTERN='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?'

# parse_openclaw_cli_version <first line of `openclaw --version`>
# Prints the bare semver on stdout and returns 0, or reports the unrecognised
# line on stderr and returns 1.
parse_openclaw_cli_version() {
  local raw="${1-}"
  raw="${raw//$'\r'/}"
  local decorated="^OpenClaw (${OPENCLAW_SEMVER_PATTERN})( \([0-9a-f]{7,40}\))?\$"
  local bare="^(${OPENCLAW_SEMVER_PATTERN})\$"
  if [[ "$raw" =~ $decorated ]] || [[ "$raw" =~ $bare ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  echo "ERROR: unrecognised 'openclaw --version' output: '${raw}'" \
    "(expected 'OpenClaw <semver> (<sha>)', 'OpenClaw <semver>' or '<semver>')" >&2
  return 1
}

# read_openclaw_cli_version <cli path or name> [args...]
# Runs `<cli> [args...] --version` and prints the parsed semver.
read_openclaw_cli_version() {
  local output
  output="$("$@" --version 2>/dev/null | head -n 1)" || true
  parse_openclaw_cli_version "$output"
}
