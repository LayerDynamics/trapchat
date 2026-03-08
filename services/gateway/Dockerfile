FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.work go.work.sum ./
COPY pkgs/go ./pkgs/go
COPY services/gateway ./services/gateway
WORKDIR /src/services/gateway
RUN go build -o /gateway ./cmd/gateway

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=build /gateway /usr/local/bin/gateway
EXPOSE 8080
ENTRYPOINT ["gateway"]
