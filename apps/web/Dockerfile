# --- build stage ---
FROM node:26-alpine AS build
WORKDIR /app
# Node 25+ removed corepack - install the pinned pnpm directly.
RUN npm install -g pnpm@9.15.0
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY . .
# Publishable key is baked into the static bundle at build time (public by design).
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
# VITE_AUTH_MODE=dev builds a hermetic, Clerk-free bundle for local/CI E2E.
ARG VITE_AUTH_MODE
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE
# PostHog analytics (public; baked into the static bundle by design). Unset =>
# analytics disabled (no-op), which is what hermetic E2E/docs builds use.
ARG VITE_PUBLIC_POSTHOG_KEY
ENV VITE_PUBLIC_POSTHOG_KEY=$VITE_PUBLIC_POSTHOG_KEY
ARG VITE_PUBLIC_POSTHOG_HOST
ENV VITE_PUBLIC_POSTHOG_HOST=$VITE_PUBLIC_POSTHOG_HOST
ARG VITE_PUBLIC_POSTHOG_RECORD
ENV VITE_PUBLIC_POSTHOG_RECORD=$VITE_PUBLIC_POSTHOG_RECORD
RUN pnpm build

# --- runtime stage ---
# Static files served by nginx. No Node runtime in production = smaller, safer.
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
