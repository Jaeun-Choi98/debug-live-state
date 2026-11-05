package container

import (
	"pjt/internal/config"
	rest "pjt/internal/transport"
)

var myContainer *Container

type Container struct {
	restServer *rest.RestServer
}

func NewContainer(cfg *config.Configuration) {

	if myContainer != nil {
		return
	}

	n := &Container{}
	n.restServer = rest.New(cfg)

	myContainer = n
}

func GetRestServer() *rest.RestServer {
	return myContainer.restServer
}

func DiscardContainer() {
	myContainer = nil
}
