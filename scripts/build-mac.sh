#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
python3 scripts/make-fixture.py
swift build --package-path macos -c release --product PassedAround --triple arm64-apple-macosx14.0
arm_dir="$(swift build --package-path macos -c release --triple arm64-apple-macosx14.0 --show-bin-path)"
swift build --package-path macos -c release --product PassedAround --triple x86_64-apple-macosx14.0
intel_dir="$(swift build --package-path macos -c release --triple x86_64-apple-macosx14.0 --show-bin-path)"
app_dir="$project_dir/build/Passed Around.app"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources" public/downloads
lipo -create "$arm_dir/PassedAround" "$intel_dir/PassedAround" -output "$app_dir/Contents/MacOS/PassedAround"
cp macos/Info.plist "$app_dir/Contents/Info.plist"
cp macos/Sources/PassedAround/Resources/demo-chat.db "$app_dir/Contents/Resources/demo-chat.db"
icon_dir="$project_dir/build/AppIcon.iconset"
mkdir -p "$icon_dir"
swift scripts/make-icon.swift "$project_dir/build/icon-1024.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$project_dir/build/icon-1024.png" --out "$icon_dir/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  sips -z "$double_size" "$double_size" "$project_dir/build/icon-1024.png" --out "$icon_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$icon_dir" -o "$app_dir/Contents/Resources/AppIcon.icns"
cp LICENSE "$app_dir/Contents/Resources/LICENSE.txt"
cp docs/THIRD_PARTY.md "$app_dir/Contents/Resources/THIRD_PARTY.txt"
codesign --force --sign - --entitlements macos/PassedAround.entitlements "$app_dir"
codesign --verify --deep --strict "$app_dir"
app_version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' macos/Info.plist)
archive="Passed-Around-${app_version}-mac.zip"
ditto -c -k --sequesterRsrc --keepParent "$app_dir" "public/downloads/$archive"
(cd public/downloads && shasum -a 256 "$archive" > SHA256SUMS.txt)
printf 'Built %s\n' "$app_dir"
