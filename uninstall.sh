#!/bin/bash
# Removes the launchd jobs. Leaves ~/.config/tab-live (token) and logs in place.
set -u
U="${1:-${SUDO_USER:-$USER}}"; UID_N=$(id -u "$U")
H=$(dscl . -read "/Users/$U" NFSHomeDirectory | awk '{print $2}')
if [[ $EUID -eq 0 ]]; then
  launchctl bootout system/com.tablive.server 2>/dev/null; rm -f /Library/LaunchDaemons/com.tablive.server.plist
fi
for L in com.tablive.server com.tablive.desktop; do
  launchctl bootout "gui/$UID_N/$L" 2>/dev/null; rm -f "$H/Library/LaunchAgents/$L.plist"
done
echo "Tab Live removed. Token and logs kept in $H/.config/tab-live and $H/Library/Logs/tab-live."
