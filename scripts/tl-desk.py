#!/usr/bin/env python3
# Streams the agent user's own macOS session (via local Screen Sharing / VNC) into Tab Live's Desktop view.
import os, time, io, traceback, logging
logging.disable(logging.CRITICAL)
import warnings; warnings.filterwarnings("ignore")
from vncdotool import api
HOME = os.path.expanduser("~")
USER = os.environ.get("USER") or os.path.basename(HOME)
D = os.path.join(HOME, ".cache/tab-live"); JPG = os.path.join(D, "desktop.jpg"); WANT = os.path.join(D, "desktop.want")
PWF = os.path.join(os.environ.get("TAB_LIVE_CONFIG_DIR", os.path.join(HOME, ".config/tab-live")), "vnc.pw")
os.makedirs(D, exist_ok=True)
def watching():
    try: return time.time() - os.path.getmtime(WANT) < 15
    except Exception: return False
while True:
    c = None
    # never attach unless tab's own GUI session exists (otherwise VNC would show Josh's console)
    import subprocess
    if subprocess.run(["/usr/bin/pgrep","-u",USER,"-x","Dock"],capture_output=True).returncode != 0:
        time.sleep(10); continue
    try:
        pw = open(PWF).read().strip()
        c = api.connect("127.0.0.1::5900", username=USER, password=pw, timeout=30)
        c.refreshScreen(incremental=False)
        last = 0
        idle_since = None
        while True:
            w = watching()
            if not w:
                # keep an occasional still so the view isn't empty, then disconnect when idle
                if time.time() - last > 30:
                    c.refreshScreen(incremental=True); last = time.time(); write = True
                else:
                    write = False
                idle_since = idle_since or time.time()
                if time.time() - idle_since > 300: break
                if not write: time.sleep(1); continue
            else:
                idle_since = None
                c.refreshScreen(incremental=True); last = time.time()
            im = c.screen.convert("RGB")
            im = im.resize((im.width // 2, im.height // 2))
            b = io.BytesIO(); im.save(b, "JPEG", quality=70)
            tmp = JPG + ".tmp"; open(tmp, "wb").write(b.getvalue()); os.replace(tmp, JPG)
            time.sleep(0.25 if w else 1)
    except Exception:
        traceback.print_exc()
    finally:
        try:
            if c: c.disconnect()
        except Exception: pass
    # idle: wait until someone opens the Desktop view
    while not watching(): time.sleep(1)
