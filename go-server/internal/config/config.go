package config

import (
	"fmt"
	"strings"

	"github.com/go-ini/ini"
)

type Configuration struct {
	// http-rest
	RestIp   string
	RestPort string
	Cors     []string
	TLS      int
	SSLCERT  string
	SSLKEY   string

	// spa
	SpaDir   string
	SpaIndex string

	// log
	LogLevel string
}

func NewConfiguration() (*Configuration, error) {
	cfgFile, err := ini.Load("env.ini")
	if err != nil {
		return nil, err
	}

	rest := cfgFile.Section("REST")
	config := &Configuration{
		RestIp:   rest.Key("IP").MustString(""),
		RestPort: rest.Key("PORT").MustString("8080"),
		TLS:      rest.Key("TLS").MustInt(0),
		SSLCERT:  rest.Key("SSLCERT").MustString(""),
		SSLKEY:   rest.Key("SSLKEY").MustString(""),
		SpaDir:   cfgFile.Section("SPA").Key("DIR").MustString("build"),
		SpaIndex: cfgFile.Section("SPA").Key("INDEX").MustString("index.html"),
		LogLevel: cfgFile.Section("LOG").Key("LEVEL").MustString("INFO"),
	}

	for _, origin := range strings.Split(rest.Key("CORS").MustString(""), ",") {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		if origin == "*" {
			config.Cors = append(config.Cors, origin)
			continue
		}
		config.Cors = append(config.Cors, fmt.Sprintf("http://%s", origin))
		if config.TLS > 0 {
			config.Cors = append(config.Cors, fmt.Sprintf("https://%s", origin))
		}
	}

	return config, nil
}
