FROM rust:1.85-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY pkgs/rust ./pkgs/rust
COPY services/relay ./services/relay
RUN cargo build --release --bin relay

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/relay /usr/local/bin/relay
EXPOSE 9000 9001
ENTRYPOINT ["relay"]
