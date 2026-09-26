#!/bin/bash
# RAMspread signing script
# Run after obtaining Apple Developer ID certificate
# Usage: ./sign.sh "Developer ID Application: YOUR NAME (TEAMID)"

set -e

IDENTITY="${1:-Developer ID Application: YOUR NAME (TEAMID)}"
BINARY="./target/release/ramspread-daemon"
ENTITLEMENTS="./entitlements.plist"

if [[ "$IDENTITY" == *"YOUR NAME"* ]]; then
    echo "ERROR: Pass your actual Developer ID as the first argument."
    echo "Usage: ./sign.sh \"Developer ID Application: Jane Smith (ABC1234567)\""
    exit 1
fi

echo "Building release binary..."
cargo build --release

echo "Signing binary..."
codesign --force --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" \
    "$BINARY"

echo "Verifying signature..."
codesign --verify --verbose "$BINARY"
spctl --assess --verbose "$BINARY"

echo "Done. Binary signed and verified."
