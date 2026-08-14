package main

import (
	"github.com/aki-riko/Melodex/backend/internal/web"
	"github.com/spf13/cobra"
)

type webCommandOptions struct {
	port        string
	noBrowser   bool
	desktopMode bool
}

func newWebCommand() *cobra.Command {
	options := &webCommandOptions{}
	command := &cobra.Command{
		Use: "web", Short: "启动 Melodex Web 服务",
		Run: func(_ *cobra.Command, _ []string) {
			if options.desktopMode {
				web.StartDesktop(options.port)
				return
			}
			web.Start(options.port, !options.noBrowser)
		},
	}
	flags := command.Flags()
	flags.StringVarP(&options.port, "port", "p", "8080", "服务端口")
	flags.BoolVar(&options.noBrowser, "no-browser", false, "不自动打开浏览器")
	flags.BoolVar(&options.desktopMode, "desktop", false, "桌面内嵌模式")
	_ = flags.MarkHidden("desktop")
	return command
}

func init() {
	rootCmd.AddCommand(newWebCommand())
}
