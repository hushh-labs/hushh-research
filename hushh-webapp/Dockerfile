# Multi-stage build for Next.js Standalone
# Optimized for Google Cloud Run (Node.js)
#
# Next.js docs: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
# Monorepo note: outputFileTracingRoot is set to ".." in next.config.ts,
# so standalone output nests under hushh-webapp/ in .next/standalone/.

# Stage 1: Build Next.js application
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (include devDeps for build)
RUN npm ci

# Copy application code
COPY . .

# Build arguments for environment variables
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_FIREBASE_VAPID_KEY
ARG NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_DEVELOPER_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_APP_ENV
ARG NEXT_PUBLIC_OBSERVABILITY_ENABLED
ARG NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED
ARG NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN
ARG NEXT_PUBLIC_LOCATION_MAP_DEMO
ARG NEXT_PUBLIC_OBSERVABILITY_DEBUG
ARG NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE
ARG NEXT_PUBLIC_GTM_ID
ARG NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
ARG NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

# Set environment variables for build
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ENV NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ENV NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_VAPID_KEY=$NEXT_PUBLIC_FIREBASE_VAPID_KEY
ENV NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=$NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_DEVELOPER_API_URL=$NEXT_PUBLIC_DEVELOPER_API_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV
ENV NEXT_PUBLIC_OBSERVABILITY_ENABLED=$NEXT_PUBLIC_OBSERVABILITY_ENABLED
ENV NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED=$NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED
ENV NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN=$NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN
ENV NEXT_PUBLIC_LOCATION_MAP_DEMO=$NEXT_PUBLIC_LOCATION_MAP_DEMO
ENV NEXT_PUBLIC_OBSERVABILITY_DEBUG=$NEXT_PUBLIC_OBSERVABILITY_DEBUG
ENV NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE=$NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE
ENV NEXT_PUBLIC_GTM_ID=$NEXT_PUBLIC_GTM_ID
ENV NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
ENV NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ENV CAPACITOR_BUILD=false
ENV NODE_ENV=production

# Build Next.js (produces .next/standalone with monorepo-aware paths)
RUN npm run build

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

# Copy the standalone output.
# Depending on the build context, Next's standalone server can land at:
# - /app/server.js
# - /app/app/server.js
# - /app/hushh-webapp/server.js
COPY --from=builder /app/.next/standalone ./

# Copy public assets and static files for the root standalone layout.
COPY --from=builder /app/public ./public

# Copy static assets
COPY --from=builder /app/.next/static ./.next/static

# Read every server chunk before binding the Cloud Run port. This makes an
# image-layer/filesystem EIO a startup failure instead of an intermittent 500
# or 120-second timeout on the first request that lazily loads that chunk.
COPY --from=builder /app/scripts/runtime/verify-server-chunks.mjs ./scripts/runtime/verify-server-chunks.mjs

# Normalize the supported standalone layouts so Cloud Run always has one
# canonical entrypoint and any nested standalone path still resolves assets.
RUN set -eux; \
    mkdir -p /app/app/.next /app/hushh-webapp/.next; \
    if [ -f /app/server.js ]; then \
      SERVER_PATH=/app/server.js; \
    elif [ -f /app/app/server.js ]; then \
      SERVER_PATH=/app/app/server.js; \
      ln -sfn /app/app/server.js /app/server.js; \
    elif [ -f /app/hushh-webapp/server.js ]; then \
      SERVER_PATH=/app/hushh-webapp/server.js; \
      ln -sfn /app/hushh-webapp/server.js /app/server.js; \
    else \
      echo "No standalone server.js found after copy" >&2; \
      find /app -maxdepth 4 -name server.js -print >&2; \
      exit 1; \
    fi; \
    for nested in /app/app /app/hushh-webapp; do \
      rm -rf "$nested/public" "$nested/.next/static"; \
      ln -sfn ../public "$nested/public"; \
      ln -sfn ../../.next/static "$nested/.next/static"; \
    done; \
    test -f "$SERVER_PATH"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Verify the immutable runtime image, then start the canonical server.
CMD ["sh", "-c", "node scripts/runtime/verify-server-chunks.mjs && exec node server.js"]
