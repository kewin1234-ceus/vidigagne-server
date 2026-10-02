FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
RUN mkdir -p data/uploads
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
