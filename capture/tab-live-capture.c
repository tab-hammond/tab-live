// Tab Live Capture: a tiny screen-capture loop for the agent user's GUI session.
// It exists as its own signed app bundle so macOS Screen Recording permission can be granted
// to exactly this program (and not to a shell). It captures only while a viewer is watching
// the Desktop view (the server touches ~/.cache/tab-live/desktop.want), plus one still a minute.
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static int run(char *const argv[]) {
  pid_t pid;
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
  int rc = posix_spawn(&pid, argv[0], &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  if (rc != 0) return -1;
  int st = 0;
  if (waitpid(pid, &st, 0) < 0) return -1;
  return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}

int main(void) {
  const char *home = getenv("HOME");
  if (!home) home = "/tmp";
  const char *envdir = getenv("TAB_LIVE_DESKTOP_DIR");
  const char *width = getenv("TAB_LIVE_DESKTOP_WIDTH"); if (!width) width = "1600";
  const char *quality = getenv("TAB_LIVE_DESKTOP_QUALITY"); if (!quality) quality = "65";
  char dir[1024], cap[1100], small[1100], out[1100], want[1100];
  if (envdir) snprintf(dir, sizeof dir, "%s", envdir); else snprintf(dir, sizeof dir, "%s/.cache/tab-live", home);
  mkdir(dir, 0700);
  snprintf(cap, sizeof cap, "%s/.cap.jpg", dir);
  snprintf(small, sizeof small, "%s/.small.jpg", dir);
  snprintf(out, sizeof out, "%s/desktop.jpg", dir);
  snprintf(want, sizeof want, "%s/desktop.want", dir);
  time_t last_idle = 0;
  int fails = 0;
  for (;;) {
    struct stat st;
    time_t now = time(NULL);
    int watching = stat(want, &st) == 0 && now - st.st_mtime < 15;
    if (watching || now - last_idle > 60) {
      char *a1[] = {"/usr/sbin/screencapture", "-x", "-t", "jpg", cap, NULL};
      char *a2[] = {"/usr/bin/sips", "-Z", (char *)width, "-s", "formatOptions", (char *)quality, cap, "--out", small, NULL};
      int ok = run(a1) == 0 && stat(cap, &st) == 0 && st.st_size > 0;
      if (ok) {
        ok = run(a2) == 0;
        if (ok) rename(small, out);
        unlink(cap);
      }
      if (!ok && ++fails % 30 == 1) fprintf(stderr, "capture failed (Screen Recording permission for Tab Live Capture?)\n");
      if (ok) fails = 0;
      if (!watching) last_idle = now;
      usleep(watching ? 600000 : 2000000);
    } else {
      sleep(2);
    }
  }
}
