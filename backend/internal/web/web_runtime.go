package web

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/gin-gonic/gin"
)

func Start(port string, openBrowser bool) {
	runWebServer(port, StartOptions{ShouldOpenBrowser: openBrowser})
}

func StartDesktop(port string) {
	runWebServer(port, StartOptions{DisableAuth: true, ListenHost: "127.0.0.1"})
}

func StartWithOptions(port string, options StartOptions) {
	runWebServer(port, options)
}

func runWebServer(port string, options StartOptions) {
	core.CM.Load()
	InitDB()
	defer CloseDB()
	startBackgroundCacheMaintenance()
	prepareInitialSetup(options)

	gin.SetMode(gin.ReleaseMode)
	handler, err := newWebRouter(options)
	if err != nil {
		writeServerError("configure", err)
		return
	}
	listener, err := net.Listen("tcp", webListenAddress(options.ListenHost, port))
	if err != nil {
		reportListenError(port, options.ListenHost, err)
		return
	}
	applicationURL := localWebAppURL(options.ListenHost, port)
	fmt.Printf("Web started at %s\n", applicationURL)
	openApplicationWhenRequested(options.ShouldOpenBrowser, applicationURL)

	server := configuredHTTPServer(handler)
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		writeServerError("serve", err)
	}
}

func prepareInitialSetup(options StartOptions) {
	if options.DisableAuth {
		return
	}
	userCount, err := countUsers()
	if err != nil {
		writeServerError("read account configuration", err)
		return
	}
	token, err := prepareSetupToken(userCount > 0)
	if err != nil {
		writeServerError("prepare setup token", err)
		return
	}
	if token != "" {
		fmt.Printf("Web setup token: %s\nOpen %s/setup and keep this startup terminal private until setup is complete.\n", token, RoutePrefix)
	}
}

func webListenAddress(host, port string) string {
	return net.JoinHostPort(strings.TrimSpace(host), port)
}

func reportListenError(port, host string, err error) {
	if strings.Contains(strings.ToLower(err.Error()), "address already in use") {
		fmt.Fprintf(os.Stderr, "Failed to start web server: port %s is already in use. Please use --port to specify another port, e.g. melodex web --port 8081\n", port)
		return
	}
	fmt.Fprintf(os.Stderr, "Failed to start web server on %s: %v\n", webListenAddress(host, port), err)
}

func configuredHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      serverWriteTimeout,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
}

func localWebAppURL(listenHost, port string) string {
	host := strings.TrimSpace(listenHost)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	address := net.JoinHostPort(host, port)
	return (&url.URL{Scheme: "http", Host: address, Path: "/"}).String()
}

func openApplicationWhenRequested(enabled bool, applicationURL string) {
	if !enabled {
		return
	}
	go func() {
		time.Sleep(500 * time.Millisecond)
		core.OpenBrowser(applicationURL)
	}()
}

func writeServerError(operation string, err error) {
	fmt.Fprintf(os.Stderr, "Web server %s failed: %v\n", operation, err)
}
