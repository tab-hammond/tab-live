#!/bin/bash
# Make "/Applications/Tab Live.app": opens Tab Live in its own Chrome app window (or the default browser).
# usage: sudo ./scripts/make-launcher-app.sh <owner-user> [token-file] [url]
# The token is baked into the app, so the bundle is owned by <owner-user> and mode 700.
set -e
OWNER="${1:?owner user}"; TOKF="${2:-$HOME/.config/tab-live/token}"; BASE="${3:-http://127.0.0.1:8335}"
TOK=$(cat "$TOKF"); A="/Applications/Tab Live.app"
rm -rf "$A"; mkdir -p "$A/Contents/MacOS" "$A/Contents/Resources"
cat > "$A/Contents/MacOS/TabLive" <<SH
#!/bin/bash
URL="$BASE/#token=$TOK"
if [ -d "/Applications/Google Chrome.app" ]; then open -na "Google Chrome" --args --app="\$URL" --window-size=1400,950; else open "\$URL"; fi
SH
chmod 755 "$A/Contents/MacOS/TabLive"
cat > "$A/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Tab Live</string><key>CFBundleIdentifier</key><string>com.tablive.launcher</string>
<key>CFBundleExecutable</key><string>TabLive</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1.0</string><key>LSUIElement</key><true/>
</dict></plist>
PL
chown -R "$OWNER" "$A"; chmod 700 "$A"; xattr -cr "$A"; codesign --force --deep -s - "$A" >/dev/null 2>&1 || true
echo "Created $A"
