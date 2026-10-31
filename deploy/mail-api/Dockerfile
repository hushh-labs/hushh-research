# hushh-mail-api — Cloud Run runtime image.
FROM node:20-alpine

WORKDIR /app

# Copy manifests first so the dependency layer caches across source changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src

# Drop privileges. The node:alpine images ship an unprivileged `node` user.
USER node

EXPOSE 8080
ENV NODE_ENV=production

CMD ["node", "index.js"]
