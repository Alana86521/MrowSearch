#!/usr/bin/env bash
set -e
mkdir -p /run/mrow /run/mrow-egress
rm -f /run/mrow/kasm.sock /run/mrow/control.sock
socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/mrow-egress/proxy.sock &
socat UNIX-LISTEN:/run/mrow/kasm.sock,mode=0600,reuseaddr,fork OPENSSL:127.0.0.1:6901,verify=0 &
node /opt/mrow/dist/worker/index.js &
openbox --replace >/tmp/openbox.log 2>&1 &
browser_args=${APP_ARGS:-"--start-maximized"}
browser_url=${LAUNCH_URL:-"about:blank"}
while true
do
    if ! pgrep -x chromium >/dev/null
    then
        /usr/bin/filter_ready /usr/bin/desktop_ready chromium $browser_args $browser_url || true
    fi
    sleep 1
done
