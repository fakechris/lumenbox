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
COPY start-display /usr/local/bin/start-display
COPY box-chrome /usr/local/bin/box-chrome
COPY box-clip /usr/local/bin/box-clip
COPY wait-compositor /usr/local/bin/wait-compositor
COPY vnc-probe /usr/local/bin/vnc-probe
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/start-display \
      /usr/local/bin/box-chrome /usr/local/bin/box-clip \
      /usr/local/bin/wait-compositor \
      /usr/local/bin/vnc-probe

# Chromium's managed policy. Two things it turns off, both of which are traps for an
# agent rather than merely untidy:
#
# The "unsupported command-line flag: --no-sandbox" infobar. The flag is deliberate — the
# container is the security boundary here, and giving Chromium's own sandbox what it needs
# would mean handing the container SYS_ADMIN or an unconfined seccomp profile, which is a
# worse trade. The bar itself shifts the page down, sits over content, and reappears on
# every launch, so it is something the model has to notice and dismiss forever.
#
# The default-browser and first-run prompts, for the same reason: a modal on first launch
# is a step no agent should have to discover.
#
# Managed policy rather than flags, because flags do not reach the warning bar.
RUN mkdir -p /etc/chromium/policies/managed \
    && printf '%s\n' '{' \
      '  "CommandLineFlagSecurityWarningsEnabled": false,' \
      '  "DefaultBrowserSettingEnabled": false,' \
      '  "PromotionalTabsEnabled": false,' \
      '  "MetricsReportingEnabled": false' \
      '}' > /etc/chromium/policies/managed/agentbox.json

EXPOSE 1337

# 7. A desktop a person would recognise.
#
#    xterm: useful to the agent in its own right — some things are easier in a
#    visible shell — and it gives the smoke test a text sink, so typing can be
#    verified end to end rather than only checking the keymap machinery ran.
#
#    pcmanfm draws desktop icons and is the file manager they point at. An empty
#    desktop is not just unfriendly: with nothing on screen there is no way to tell
#    a working box from a broken one at a glance, and that is the first thing anyone
#    checks. It also gives a vision model landmarks to orient by.
#
#    wmctrl for window and workspace management, which xdotool cannot do.
#    adwaita-icon-theme so the launchers render as icons rather than blanks.
#
#    fonts-noto-cjk because without it every Chinese, Japanese and Korean character
#    renders as a tofu box. It fails in the worst way for an agent: the page loads, the
#    screenshot succeeds, and the model reads a grid of empty rectangles — so it acts on
#    a page it cannot actually see. Worth ~100MB in the image; a CUA box that cannot
#    read half the web is not worth the space it saves.
#
#    xfce4-terminal and thunar rather than xterm and pcmanfm's own windows: the box is
#    something a person looks at and takes over, and xterm's 1980s defaults read as
#    broken software rather than as a terminal. pcmanfm stays, but only as the layer
#    that draws the desktop and its icons.
#
#    dconf-cli to pre-seed GTK settings that have no config-file equivalent.
#
#    picom and plank are the dock. plank needs alpha compositing for its theme, and X
#    without a compositor has no way to blend windows — each window owns its pixels on
#    the shared framebuffer and there is nothing behind them to blend with. picom gives
#    every window an off-screen buffer and combines them, which is what makes a
#    translucent dock (and shadows, and rounded corners) possible at all.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xterm xfce4-terminal thunar pcmanfm wmctrl dconf-cli \
      picom plank \
      autocutsel xclip \
      adwaita-icon-theme fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# A wallpaper, generated rather than shipped: ffmpeg is already here, and a real
# gradient is the difference between a desktop that looks configured and one that looks
# like it failed to start. A flat colour reads as the latter.
RUN mkdir -p /usr/share/backgrounds \
    && ffmpeg -hide_banner -loglevel error -f lavfi \
      -i "gradients=s=1280x800:c0=0x141a26:c1=0x243050:x0=0:y0=0:x1=1280:y1=800" \
      -frames:v 1 -y /usr/share/backgrounds/agentbox.png

# 8. Desktop launchers, and a pcmanfm background matching the plain-X one.
#
#    libfm's quick_exec is what makes a launcher launch. Without it, activating a
#    .desktop file opens an "Execute File" dialog offering Execute / Execute in
#    Terminal / Open — so the icons read as broken to a person, and to an agent they
#    are a trap: a modal it has to notice and dismiss before anything happens. The
#    executable bit below is necessary but does not by itself skip the prompt.
RUN mkdir -p /home/box/Desktop /home/box/.config/pcmanfm/default \
      /home/box/.config/libfm \
    && printf '%s\n' '[config]' 'quick_exec=1' \
      > /home/box/.config/libfm/libfm.conf \
    && printf '%s\n' \
      '[Desktop Entry]' 'Type=Application' 'Name=Terminal' \
      'Exec=xfce4-terminal' 'Icon=utilities-terminal' 'Terminal=false' \
      > /home/box/Desktop/terminal.desktop \
    && printf '%s\n' \
      '[Desktop Entry]' 'Type=Application' 'Name=Chromium' \
      'Exec=box-chrome' 'Icon=web-browser' 'Terminal=false' \
      > /home/box/Desktop/chromium.desktop \
    && printf '%s\n' \
      '[Desktop Entry]' 'Type=Application' 'Name=Files' \
      'Exec=thunar /home/box/work' 'Icon=system-file-manager' 'Terminal=false' \
      > /home/box/Desktop/files.desktop \
    && printf '%s\n' \
      '[*]' 'wallpaper_mode=stretch' \
      'wallpaper=/usr/share/backgrounds/agentbox.png' 'desktop_bg=#141a26' \
      'desktop_fg=#e6e9ef' 'desktop_shadow=#000000' 'show_wm_menu=0' \
      > /home/box/.config/pcmanfm/default/desktop-items-0.conf \
    && mkdir -p /home/box/.config/plank/dock1/launchers \
    && printf '%s\n' '[PlankDockItemPreferences]' \
      'Launcher=file:///home/box/Desktop/chromium.desktop' \
      > /home/box/.config/plank/dock1/launchers/chromium.dockitem \
    && printf '%s\n' '[PlankDockItemPreferences]' \
      'Launcher=file:///home/box/Desktop/files.desktop' \
      > /home/box/.config/plank/dock1/launchers/files.dockitem \
    && printf '%s\n' '[PlankDockItemPreferences]' \
      'Launcher=file:///home/box/Desktop/terminal.desktop' \
      > /home/box/.config/plank/dock1/launchers/terminal.dockitem \
    && chmod +x /home/box/Desktop/*.desktop \
    && chown -R box:box /home/box/Desktop /home/box/.config \
    # A copy the image owns. /home/box/.config is a volume at runtime, so it outlives
    # the image: without re-seeding from here on every start, an old volume would keep
    # shadowing whatever config a rebuilt image ships. The originals above stay, so a
    # fresh volume is still seeded by Docker with the right owner.
    && mkdir -p /usr/local/share/agentbox/skel \
    && cp -a /home/box/Desktop /home/box/.config /usr/local/share/agentbox/skel/

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
