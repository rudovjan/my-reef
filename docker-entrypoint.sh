#!/bin/sh
set -eu
node setup-password.mjs --if-missing
exec node server.mjs
