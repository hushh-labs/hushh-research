// Local rehearsal adapter. Pion owns TURN, authentication and packet forwarding.
// Never use this loopback-only listener as a deployed relay configuration.
package main

import (
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/pion/turn/v5"
)

func main() {
	secret := os.Getenv("DIRECT_CALLS_TURN_SECRET")
	if len(secret) < 32 {
		fmt.Fprintln(os.Stderr, "Missing rehearsal relay configuration")
		os.Exit(1)
	}
	listener, err := net.ListenPacket("udp4", "127.0.0.1:3478")
	if err != nil {
		fmt.Fprintln(os.Stderr, "Rehearsal TURN port unavailable")
		os.Exit(1)
	}
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: "calling-rehearsal.invalid",
		AuthHandler: turn.LongTermTURNRESTAuthHandler(secret, nil),
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: listener,
			PermissionHandler: func(_ net.Addr, peer net.IP) bool { return peer.IsLoopback() },
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1",
			},
		}},
	})
	if err != nil {
		_ = listener.Close()
		fmt.Fprintln(os.Stderr, "Rehearsal TURN initialization failed")
		os.Exit(1)
	}
	defer server.Close()
	fmt.Println(`{"relayReady":true,"transport":"udp","scope":"loopback"}`)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
}
