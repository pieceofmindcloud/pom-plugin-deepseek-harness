#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
platform=""
version=""
output="${root}/dist-release"
dsh_version="${DSH_VERSION:-latest}"

usage() {
  printf '%s\n' \
    'Usage: scripts/package.sh --platform <linux-x86_64|macos-aarch64|windows-x86_64> --version <semver> [options]' \
    '  --output <dir>        package directory (default: dist-release)' \
    '  --dsh-version <tag>   @deepseek-ai/dsh npm dist-tag or version the plugin tracks at runtime (default: latest)'
}

die() {
  printf 'package: %s\n' "$1" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --platform) (($# >= 2)) || die '--platform requires a value'; platform="$2"; shift 2 ;;
    --version) (($# >= 2)) || die '--version requires a value'; version="$2"; shift 2 ;;
    --output) (($# >= 2)) || die '--output requires a value'; output="$2"; shift 2 ;;
    --dsh-version) (($# >= 2)) || die '--dsh-version requires a value'; dsh_version="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$platform" ]] || die '--platform is required'
[[ -n "$version" ]] || die '--version is required'
command -v jq >/dev/null 2>&1 || die 'jq is required'

plugin_code="$(jq -er '.plugin_code | strings' "$root/ui/manifest.json")" || die 'manifest has no plugin code'
[[ "$plugin_code" =~ ^[a-z][a-z0-9_]{1,63}$ ]] || die 'manifest plugin code is invalid'

build_output="$("$root/scripts/build.sh" --platform "$platform" --output "$output" --dsh-version "$dsh_version")"
artifact="$(printf '%s\n' "$build_output" | sed -n 's/^artifact=//p')"
sha256="$(printf '%s\n' "$build_output" | sed -n 's/^sha256=//p')"
size="$(printf '%s\n' "$build_output" | sed -n 's/^size=//p')"
target="$(printf '%s\n' "$build_output" | sed -n 's/^target=//p')"
dsh_resolved="$(printf '%s\n' "$build_output" | sed -n 's/^dsh_version=//p')"

metadata="${output}/pom-plugin-deepseek-harness-${platform}.metadata.json"
cat > "$metadata" <<JSON
{
  "plugin_code": "${plugin_code}",
  "version": "${version}",
  "platform": "${platform}",
  "target": "${target}",
  "plugin_abi": 1,
  "sha256": "${sha256}",
  "size": ${size},
  "artifact": "$(basename "$artifact")",
  "dsh_version": "${dsh_resolved}"
}
JSON

printf 'artifact=%s\nmetadata=%s\nsha256=%s\nsize=%s\nversion=%s\nplatform=%s\ndsh_version=%s\n' \
  "$artifact" "$metadata" "$sha256" "$size" "$version" "$platform" "$dsh_resolved"
