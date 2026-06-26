# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY . .
# Publishable key is baked into the static bundle at build time (public by design).
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
# VITE_AUTH_MODE=dev builds a hermetic, Clerk-free bundle for local/CI E2E.
ARG VITE_AUTH_MODE
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE
RUN pnpm build

# --- runtime stage ---
# Static files served by nginx. No Node runtime in production = smaller, safer.
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
