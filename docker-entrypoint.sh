#!/bin/sh
# Hosting platforms usually mount volumes owned by root. Fix the ownership of the data folder,
# then drop to the unprivileged "node" user to run the app.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
