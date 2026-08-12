#!/usr/bin/env bash
set -e
mkdir -p /run/mrow /run/mrow-egress
rm -f /run/mrow/kasm.sock /run/mrow/control.sock
socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/mrow-egress/proxy.sock &
socat UNIX-LISTEN:/run/mrow/kasm.sock,mode=0600,reuseaddr,fork OPENSSL:127.0.0.1:6901,verify=0 &
node /opt/mrow/dist/worker/index.js &
worker_pid=$!
browser_arguments_value=${APP_ARGS:-"--start-maximized"}
read -r -a browser_arguments <<< "$browser_arguments_value"
browser_url=${LAUNCH_URL:-"about:blank"}
while true
do
    if ! kill -0 "$worker_pid" 2>/dev/null
    then
        wait "$worker_pid"
        exit $?
    fi
    if ! pgrep -x chromium >/dev/null
    then
        /usr/bin/filter_ready
        /usr/bin/desktop_ready
        chromium "${browser_arguments[@]}" "$browser_url" || true
    fi
    sleep 1
done
