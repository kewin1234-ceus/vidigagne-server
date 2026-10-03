FROM node:24-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages vosk
# modèle français Vosk (~41 Mo, 100% hors ligne)
RUN python3 -c "import urllib.request,zipfile,os; \
    u='https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip'; \
    urllib.request.urlretrieve(u,'/tmp/fr.zip'); \
    zipfile.ZipFile('/tmp/fr.zip').extractall('/app'); \
    os.rename('/app/vosk-model-small-fr-0.22','/app/vosk-model-fr'); \
    os.unlink('/tmp/fr.zip')"
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js transcribe.py ./
RUN mkdir -p data/uploads
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
