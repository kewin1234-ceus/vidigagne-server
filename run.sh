#!/bin/bash
# Lanceur VidiGagne Server avec redémarrage automatique
cd /home/hatch/workspace/vidigagne-server
while true; do
  /usr/bin/node server.js >> server.log 2>&1
  echo "[$(date)] redémarrage dans 5s..." >> server.log
  sleep 5
done
