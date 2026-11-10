ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js catalog.json ./
COPY public ./public

CMD ["node", "/app/server.js"]
