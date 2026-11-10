#!/bin/bash
# Builds "Tab Live Capture.app" (ad-hoc signed) into ./build. Needs Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/Tab Live Capture.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cp capture/Info.plist "$APP/Contents/Info.plist"
clang -O2 -Wall -o "$APP/Contents/MacOS/tab-live-capture" capture/tab-live-capture.c
codesign --force --sign - --identifier com.tablive.capture "$APP"
echo "built $APP"
