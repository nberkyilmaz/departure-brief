# The API and the web app it serves, as one image.
#
# Built in two stages so the runtime carries no compiler, no test fixtures
# and no development dependencies. The web app is built here rather than
# committed, so what is served always matches the source it was built from.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build -w apps/web
# Fail the build rather than shipping an image whose page is empty.
RUN test -s apps/web/dist/index.html

# Reinstall without development dependencies, for copying into the runtime.
RUN npm ci --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the unprivileged user the base image already provides.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/core ./packages/core
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
# Aircraft data is read from disk at request time; profiles supply the defaults.
COPY --from=build --chown=node:node /app/aircraft ./aircraft
COPY --from=build --chown=node:node /app/profiles ./profiles

# The host sets PORT; this is only the default for running the image directly.
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

# tsx runs the TypeScript sources directly, which is what the repo does
# everywhere else — one way of running the code, not two.
CMD ["npx", "tsx", "apps/api/src/main.ts"]
