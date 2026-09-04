# No build step - this is a plain Node.js + Express + Socket.IO app, so a
# single stage is all that's needed (no compiling/bundling to separate out).
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Copy just the package files first so `npm ci` is only re-run (and its
# layer only invalidated) when a dependency actually changes, not on every
# source edit.
COPY package.json package-lock.json ./
# --omit=dev skips devDependencies (socket.io-client, used only by
# scripts/playtest.js for local testing - not needed to run the server).
RUN npm ci --omit=dev

COPY . .

# The official Node images already include a low-privilege "node" user for
# exactly this purpose - running as root in a container is an easy,
# unnecessary privilege-escalation surface for no benefit here.
USER node

# Documents the default; actually configurable via `docker run -e PORT=...`
# the same way as any other deployment - see README.md.
ENV PORT=3000
EXPOSE 3000

# Plain exec-form CMD (no shell wrapping it) so the container's PID 1 is
# node itself, not a shell - `docker stop`'s SIGTERM reaches server.js's
# own shutdown() handler directly instead of being swallowed by an
# intermediate shell process that never forwards it.
CMD ["node", "server.js"]
