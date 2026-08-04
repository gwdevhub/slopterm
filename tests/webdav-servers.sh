#!/usr/bin/env bash
# Runs the WebDAV suite (WebDavRemoteTests + WebDavIntegrationTests) against more than one
# server implementation, because that is exactly where WebDAV servers disagree - ETags,
# preconditions, whether MKCOL on an existing path is 405 or 201, whether PROPFIND returns
# the collection itself. A single server passing proves the code works with that server.
#
#   ./tests/webdav-servers.sh                 # Apache mod_dav + KaraDAV, in throwaway containers
#   ./tests/webdav-servers.sh https://…       # …plus a share you already have
#
# Credentials for an extra share come from SLOPTERM_WEBDAV_USER / SLOPTERM_WEBDAV_PASS.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="slopterm"
PASSWORD="slopterm-test-pw"
FAILED=0

# Only for running this script itself inside a container that reaches the Docker daemon over
# a mounted socket (Docker-outside-of-Docker): published ports land on the host's network
# namespace, not this one, so the servers below would be started but unreachable. Sharing the
# caller's namespace with `container:<id>` puts them on this 127.0.0.1 instead. Unset on any
# normal machine or CI runner, where -p works as expected.
#   SLOPTERM_DOCKER_NETWORK="container:$(cat /proc/self/cgroup | head -1 | sed 's#.*/##')"
if [ -n "${SLOPTERM_DOCKER_NETWORK:-}" ]; then
  # Sharing a namespace means -p doesn't apply - the servers are on their own native ports.
  NET_ARGS=(--network "$SLOPTERM_DOCKER_NETWORK")
  APACHE_PORT_ARGS=()
  KARADAV_PORT_ARGS=()
  APACHE_PORT=80
  KARADAV_PORT=8080
else
  NET_ARGS=()
  APACHE_PORT_ARGS=(-p 127.0.0.1:8081:80)
  KARADAV_PORT_ARGS=(-p 127.0.0.1:8082:8080)
  APACHE_PORT=8081
  KARADAV_PORT=8082
fi

APACHE_URL="http://127.0.0.1:$APACHE_PORT/dav/"
KARADAV_URL="http://127.0.0.1:$KARADAV_PORT/files/$USER_NAME/"

cleanup() {
  docker rm -f slopterm-dav-apache >/dev/null 2>&1 || true
  docker rm -f slopterm-dav-karadav >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() {
  local url=$1
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null -u "$USER_NAME:$PASSWORD" "$url"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $url" >&2
  return 1
}

run_against() {
  local label=$1 url=$2 user=$3 pass=$4
  echo
  echo "=== $label ($url) ==============================================================="
  if SLOPTERM_WEBDAV_URL="$url" SLOPTERM_WEBDAV_USER="$user" SLOPTERM_WEBDAV_PASS="$pass" \
     dotnet test "$HERE" --nologo -v q \
     --filter 'FullyQualifiedName~WebDav'; then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    FAILED=1
  fi
}

# --- Apache mod_dav -----------------------------------------------------------------------
# The reference implementation everything else is measured against, and the strictest about
# preconditions.
docker rm -f slopterm-dav-apache >/dev/null 2>&1 || true
docker run -d --name slopterm-dav-apache "${NET_ARGS[@]}" "${APACHE_PORT_ARGS[@]}" httpd:2.4 >/dev/null
docker exec slopterm-dav-apache bash -c "
  set -e
  sed -i 's/^#\(LoadModule dav_module\)/\1/; s/^#\(LoadModule dav_fs_module\)/\1/; s/^#\(LoadModule auth_digest_module\)/\1/' /usr/local/apache2/conf/httpd.conf
  # Owned by whichever user httpd.conf actually drops to - the official image says
  # www-data, not the daemon:daemon the docs assume, and MKCOL just answers 500 if the DAV
  # root and the lock database aren't writable by it.
  mkdir -p /var/dav /usr/local/apache2/var
  APACHE_USER=\$(awk '/^User /{print \$2}' /usr/local/apache2/conf/httpd.conf)
  chown -R \"\$APACHE_USER\" /var/dav /usr/local/apache2/var
  htpasswd -bc /usr/local/apache2/conf/dav.passwd '$USER_NAME' '$PASSWORD'
  cat >> /usr/local/apache2/conf/httpd.conf <<'CONF'
DavLockDB /usr/local/apache2/var/DavLock
Alias /dav /var/dav
<Directory /var/dav>
    Dav On
    Options Indexes
    AuthType Basic
    AuthName \"slopterm\"
    AuthUserFile /usr/local/apache2/conf/dav.passwd
    Require valid-user
</Directory>
CONF
  apachectl -k graceful
" >/dev/null
wait_for "$APACHE_URL"
run_against "Apache mod_dav" "$APACHE_URL" "$USER_NAME" "$PASSWORD"

# --- KaraDAV ------------------------------------------------------------------------------
# Nextcloud-compatible and light, so it stands in for the Nextcloud quirks the sync loop has
# to tolerate without needing a full Nextcloud stack.
docker rm -f slopterm-dav-karadav >/dev/null 2>&1 || true
if docker run -d --name slopterm-dav-karadav "${NET_ARGS[@]}" "${KARADAV_PORT_ARGS[@]}" \
     -e KD_DEFAULT_USER="$USER_NAME" -e KD_DEFAULT_PASSWORD="$PASSWORD" \
     ghcr.io/kd2org/karadav:latest >/dev/null 2>&1 && \
   wait_for "$KARADAV_URL"; then
  run_against "KaraDAV" "$KARADAV_URL" "$USER_NAME" "$PASSWORD"
else
  echo "SKIP: KaraDAV image unavailable" >&2
fi

# --- whatever the caller passed -----------------------------------------------------------
if [ $# -ge 1 ]; then
  run_against "custom" "$1" "${SLOPTERM_WEBDAV_USER:-}" "${SLOPTERM_WEBDAV_PASS:-}"
fi

exit $FAILED
