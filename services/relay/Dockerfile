FROM rust:1.85-slim@sha256:3490aa77d179a59d67e94239cca96dd84030b564470859200f535b942bdffedf AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY pkgs/rust ./pkgs/rust
COPY services/relay ./services/relay
RUN cargo build --release --bin relay

FROM debian:bookworm-slim@sha256:74a21da88cf4b2e8fde34558376153c5cd80b00ca81da2e659387e76524edc73
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/* && \
    useradd -r -s /usr/sbin/nologin appuser
COPY --from=build /src/target/release/relay /usr/local/bin/relay
USER appuser
EXPOSE 9000 9001
ENTRYPOINT ["relay"]
