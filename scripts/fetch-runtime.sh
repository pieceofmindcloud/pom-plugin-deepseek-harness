#!/usr/bin/env bash
# Assembles the harness runtime the plugin embeds: a portable Node.js, the
# official prebuilt `@deepseek-ai/dsh` release from npm, and our launcher.
# No harness source is cloned or compiled; native npm dependencies resolve for
# the platform this script runs on, so run it on the target platform.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
platform=""
dsh_version="${DSH_VERSION:-latest}"
node_version="${DSH_NODE_VERSION:-24.9.0}"
output="${root}/build"

usage() {
  printf '%s\n' \
    'Usage: scripts/fetch-runtime.sh --platform <linux-x86_64|macos-aarch64|windows-x86_64> [options]' \
    '  --dsh-version <tag|version>  npm dist-tag or exact version of @deepseek-ai/dsh (default: latest)' \
    '  --node-version <version>     portable Node.js version (default: 24.9.0)' \
    '  --output <dir>               build directory (default: build)'
}

die() {
  printf 'fetch-runtime: %s\n' "$1" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --platform) (($# >= 2)) || die '--platform requires a value'; platform="$2"; shift 2 ;;
    --dsh-version) (($# >= 2)) || die '--dsh-version requires a value'; dsh_version="$2"; shift 2 ;;
    --node-version) (($# >= 2)) || die '--node-version requires a value'; node_version="$2"; shift 2 ;;
    --output) (($# >= 2)) || die '--output requires a value'; output="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$platform" ]] || die '--platform is required'
case "$platform" in
  linux-x86_64) node_dist="node-v${node_version}-linux-x64"; node_archive="${node_dist}.tar.xz"; keep_pty="linux-x64" ;;
  macos-aarch64) node_dist="node-v${node_version}-darwin-arm64"; node_archive="${node_dist}.tar.gz"; keep_pty="darwin-arm64" ;;
  windows-x86_64) node_dist="node-v${node_version}-win-x64"; node_archive="${node_dist}.zip"; keep_pty="win32-x64" ;;
  *) die "unsupported platform: $platform" ;;
esac
for tool in curl npm tar; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

resolved="$(npm view "@deepseek-ai/dsh@${dsh_version}" version --json | tr -d '"[:space:]')"
[[ "$resolved" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "could not resolve @deepseek-ai/dsh@${dsh_version}"

stage="${output}/runtime-${platform}"
downloads="${output}/downloads"
rm -rf "$stage"
mkdir -p "$stage/app" "$stage/bin" "$downloads"

# Portable Node.js, verified against the release's SHASUMS256.
node_url="https://nodejs.org/dist/v${node_version}"
[[ -f "${downloads}/${node_archive}" ]] || curl -fsSL -o "${downloads}/${node_archive}" "${node_url}/${node_archive}"
expected="$(curl -fsSL "${node_url}/SHASUMS256.txt" | awk -v name="$node_archive" '$2 == name {print $1}')"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${downloads}/${node_archive}" | awk '{print $1}')"
else
  actual="$(sha256sum "${downloads}/${node_archive}" | awk '{print $1}')"
fi
[[ -n "$expected" && "$actual" == "$expected" ]] || die "Node.js archive checksum mismatch for ${node_archive}"
unpack="${output}/node-unpack"
rm -rf "$unpack" && mkdir -p "$unpack"
case "$node_archive" in
  *.zip) (cd "$unpack" && unzip -q "${downloads}/${node_archive}") ;;
  *) tar -xf "${downloads}/${node_archive}" -C "$unpack" ;;
esac
if [[ "$platform" == windows-x86_64 ]]; then
  cp "${unpack}/${node_dist}/node.exe" "$stage/bin/node.exe"
else
  cp "${unpack}/${node_dist}/bin/node" "$stage/bin/node"
fi
cp "${unpack}/${node_dist}/LICENSE" "$stage/bin/NODE_LICENSE"
rm -rf "$unpack"

# Official harness release, production dependencies only.
cat > "$stage/app/package.json" <<JSON
{ "name": "pom-dsh-runtime", "private": true, "dependencies": { "@deepseek-ai/dsh": "${resolved}" } }
JSON
(
  cd "$stage/app"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >&2
)

# Drop prebuilt binaries and type declarations the target never loads.
if [[ -d "$stage/app/node_modules/node-pty/prebuilds" ]]; then
  find "$stage/app/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "$keep_pty" -exec rm -rf {} +
fi
find "$stage/app/node_modules" -name '*.d.ts' -type f -delete

cp "$root/runtime/launcher.mjs" "$stage/launcher.mjs"
printf '{\n  "dsh_version": "%s",\n  "node_version": "%s",\n  "platform": "%s"\n}\n' \
  "$resolved" "$node_version" "$platform" > "$stage/runtime.json"

archive="${output}/runtime-${platform}.tar.gz"
# macOS tar would add an AppleDouble `._*` entry for every file with extended attributes.
COPYFILE_DISABLE=1 tar -czf "$archive" -C "$stage" .
size="$(wc -c < "$archive" | tr -d '[:space:]')"
if command -v shasum >/dev/null 2>&1; then
  sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
  sha256="$(sha256sum "$archive" | awk '{print $1}')"
fi
printf '%s\n' "$sha256" > "${archive}.sha256"
printf 'archive=%s\nsha256=%s\ndsh_version=%s\nnode_version=%s\nsize=%s\n' \
  "$archive" "$sha256" "$resolved" "$node_version" "$size"
