# Test-only GTK fixture bindings above the actual box artifact; production stays unchanged.
ARG BOX_IMAGE=agentbox/cua-fixes:latest
FROM ${BOX_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends gir1.2-gtk-3.0 \
    && rm -rf /var/lib/apt/lists/*
