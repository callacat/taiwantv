FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server.js .
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
