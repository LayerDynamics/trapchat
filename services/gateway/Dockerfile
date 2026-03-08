FROM golang:1.24-alpine@sha256:757779acac4af1b349a20f357c7296097b4a0b89da4ad0e370b339060077282a AS build
WORKDIR /src
COPY go.work go.work.sum ./
COPY pkgs/go ./pkgs/go
COPY services/gateway ./services/gateway
WORKDIR /src/services/gateway
RUN go build -o /gateway ./cmd/gateway

FROM alpine:3.21@sha256:22e0ec13c0db6b3e1ba3280e831fc50ba7bffe58e81f31670a64b1afede247bc
RUN apk add --no-cache ca-certificates && adduser -D -s /sbin/nologin appuser
COPY --from=build /gateway /usr/local/bin/gateway
USER appuser
EXPOSE 8080
ENTRYPOINT ["gateway"]
