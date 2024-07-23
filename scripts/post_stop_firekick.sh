#!/bin/bash


: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# backup and cleanup local payload
# ignore error when payload does not exist
redis-cli rename "firekick:local:payload" "firekick:local:payload:backup" 2>/dev/null

# cleanup iptables
sudo iptables -t nat -S | fgrep -- '-p tcp -m tcp --dport 80 -j REDIRECT --to-ports 8835' | sed 's=^-A =-D =g' | xargs -r -L 1 sudo iptables -t nat

${NEED_FIRESTATUS:=false} && curl -s 'http://127.0.0.1:9966/resolve?name=firekick&type=ready_for_pairing'
