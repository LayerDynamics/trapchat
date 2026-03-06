module trapchat/gateway

go 1.26.0

require (
	github.com/gorilla/websocket v1.5.3
	trapchat/pkgs v0.0.0
)

replace trapchat/pkgs => ../../pkgs/go
