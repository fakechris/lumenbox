# The box: a Linux desktop the agents share, plus the daemon that drives it.
#
# Deliberately not systemd-based: a plain entrypoint script that supervises a handful of processes is
# easier to debug and does not need a privileged container.
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DISPLAY=:1 \
    DISPLAY_WIDTH=1280 \
    DISPLAY_HEIGHT=800 \
    HOME=/home/box

# 1. The computer-use toolchain. xdotool synthesizes input, ffmpeg captures the
#    framebuffer, xrandr/xdpyinfo report geometry, xmodmap lends keycodes to
#    unmapped Unicode characters.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc xdotool xauth x11-xserver-utils x11-utils \
      ffmpeg \
      xfwm4 xfconf dbus-x11 \
      novnc websockify \
      fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# 2. General-purpose tools the agents reach for through the bash tool.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg \
      git jq ripgrep less vim-tiny procps psmisc \
      python3 python3-venv \
      sudo tini \
    && rm -rf /var/lib/apt/lists/*

# 3. Node.js for the daemon.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 4. Chromium for browser work. Installed from Debian rather than Google's repo so
#    the image builds on both amd64 and arm64.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium chromium-sandbox \
    && rm -rf /var/lib/apt/lists/*

# 5. An unprivileged user. The agent has sudo — it is expected to install things —
#    but the container boundary, not the user boundary, is what contains it.
RUN useradd --create-home --shell /bin/bash --uid 1000 box \
    && echo "box ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/box \
    && chmod 0440 /etc/sudoers.d/box \
    && mkdir -p /home/box/work /opt/boxd \
    && chown -R box:box /home/box \
    # Xvfb binds its socket here and cannot create the directory as non-root.
    && mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

# 6. The daemon bundle, built by `npm run build:boxd`, plus the browser wrapper.
COPY boxd.cjs /opt/boxd/boxd.cjs
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY box-chrome /usr/local/bin/box-chrome
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/box-chrome

EXPOSE 1337 6080

# 7. A terminal on the desktop. Useful to the agent in its own right — some things
#    are easier to do in a visible shell than through the bash tool — and it gives
#    the smoke test a text sink, so typing can be verified end to end rather than
#    only checking that the keymap machinery ran.
RUN apt-get update && apt-get install -y --no-install-recommends xterm \
    && rm -rf /var/lib/apt/lists/*

# Run the desktop and the daemon as the unprivileged user. Nothing in the stack
# needs root — Xvfb, xfwm4, x11vnc, websockify, and node all run fine as `box` —
# and leaving it as root means every file the agent creates lands root-owned,
# which breaks the browser profile in confusing ways. The agent still has
# passwordless sudo for the cases that genuinely need it.
USER box
WORKDIR /home/box/work

HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=6 \
  CMD curl -fsS http://127.0.0.1:1337/health > /dev/null || exit 1

# tini reaps the desktop processes the entrypoint spawns.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
