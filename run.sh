#!/bin/bash
# Lanceur VidiGagne Server avec redémarrage automatique
cd /home/hatch/workspace/vidigagne-server
# v2.34 : exporte le token admin pour que les endpoints /api/admin/* répondent
# quel que soit le processus qui (re)lance run.sh (boucle, watchdog, relance manuelle).
if [ -f /home/hatch/workspace/vidigagne/.admin-token ]; then
  export ADMIN_TOKEN="$(cat /home/hatch/workspace/vidigagne/.admin-token)"
fi
while true; do
  /usr/bin/node server.js >> server.log 2>&1
  echo "[$(date)] redémarrage dans 5s..." >> server.log
  sleep 5
done
