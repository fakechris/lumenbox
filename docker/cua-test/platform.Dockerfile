# Offline runtime fixtures only; these dependencies never enter the shipped box image.
ARG TEST_IMAGE=agentbox/cua-fixes-test:latest
FROM ${TEST_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3-pyqt5 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/cua-electron --omit=dev --no-audit --no-fund electron@44.3.0 \
    && node /opt/cua-electron/node_modules/electron/install.js \
    && chown -R box:box /home/box/.cache
COPY qt-fixture.py web-fixture.mjs electron-fixture.cjs /opt/cua-fixtures/
