# --- build stage ---
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static, stripped binary — no libc, no debug info.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api .

# --- runtime stage ---
# distroless/static: ~2MB, shell-less, non-root — but unlike bare `scratch` it
# ships CA certs AND /etc/nsswitch.conf + /etc/resolv handling. Bare scratch's
# missing nsswitch made the pure-Go DNS resolver flaky for outbound hosts
# (api.clerk.com), so clerk-sdk-go's JWKS fetch intermittently failed and the
# instance rejected every token (401). Distroless makes DNS/TLS deterministic.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api
EXPOSE 8080
ENTRYPOINT ["/api"]
