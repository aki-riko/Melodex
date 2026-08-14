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

func Start(port string, shouldOpenBrowser bool) {
	StartWithOptions(port, StartOptions{ShouldOpenBrowser: shouldOpenBrowser})
}

func StartDesktop(port string) {
	StartWithOptions(port, StartOptions{DisableAuth: true, ListenHost: "127.0.0.1"})
}

func StartWithOptions(port string, options StartOptions) {
	core.CM.Load()
	InitDB()
	defer CloseDB()
	startBackgroundCacheMaintenance()
	prepareInitialSetup(options)

	gin.SetMode(gin.ReleaseMode)
	router, err := newWebRouter(options)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to configure web server: %v\n", err)
		return
	}
	listener, err := listenForWeb(options.ListenHost, port)
	if err != nil {
		reportListenError(port, options.ListenHost, err)
		return
	}

	appURL := localWebAppURL(options.ListenHost, port)
	fmt.Printf("Web started at %s\n", appURL)
	if options.ShouldOpenBrowser {
		go func() {
			time.Sleep(500 * time.Millisecond)
			core.OpenBrowser(appURL)
		}()
	}
	server := configuredHTTPServer(router)
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintf(os.Stderr, "Web server stopped with error: %v\n", err)
	}
}

func prepareInitialSetup(options StartOptions) {
	if options.DisableAuth {
		return
	}
	users, err := countUsers()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to read account config: %v\n", err)
		return
	}
	token, err := prepareSetupToken(users > 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to prepare web setup token: %v\n", err)
		return
	}
	if token != "" {
		fmt.Printf("Web setup token: %s\nOpen %s/setup and keep this startup terminal private until setup is complete.\n", token, RoutePrefix)
	}
}

func listenForWeb(host, port string) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort(strings.TrimSpace(host), port))
}

func reportListenError(port, host string, err error) {
	if strings.Contains(strings.ToLower(err.Error()), "address already in use") {
		fmt.Fprintf(os.Stderr, "Failed to start web server: port %s is already in use. Please use --port to specify another port, e.g. music-dl web --port 8081\n", port)
		return
	}
	fmt.Fprintf(os.Stderr, "Failed to start web server on %s: %v\n", net.JoinHostPort(strings.TrimSpace(host), port), err)
}

func configuredHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: serverWriteTimeout,
		IdleTimeout: 120 * time.Second, MaxHeaderBytes: 1 << 20,
	}
}

func localWebAppURL(listenHost, port string) string {
	host := strings.TrimSpace(listenHost)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	return (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, port), Path: "/"}).String()
}
