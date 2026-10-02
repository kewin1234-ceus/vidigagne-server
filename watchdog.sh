#!/bin/bash
# Gardien : relance le serveur s'il ne répond plus
if ! curl -s -m 5 http://localhost:3000/api/health | grep -q '"ok":true'; then
  pkill -f "vidigagne-server/run.sh"
  sleep 1
  nohup /home/hatch/workspace/vidigagne-server/run.sh >/dev/null 2>&1 &
  echo "[$(date)] serveur relancé" >> /home/hatch/workspace/vidigagne-server/server.log
fi
