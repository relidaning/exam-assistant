FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir data && chown node:node data

COPY server.mjs ./
COPY lib/ lib/
COPY public/ public/
COPY scripts/ scripts/
COPY examples/ examples/

USER node
EXPOSE 8710
CMD ["node", "server.mjs"]
