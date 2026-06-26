# --- build stage ---
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static, stripped binary — no libc, no debug info.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api .

# --- runtime stage ---
# scratch = nothing but our binary. Smallest possible image, no shell, no CVEs from base packages.
FROM scratch
COPY --from=build /out/api /api
EXPOSE 8080
USER 65534:65534
ENTRYPOINT ["/api"]
