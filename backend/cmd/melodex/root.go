package main

import (
	"fmt"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/spf13/cobra"
)

var showVersion bool

var rootCmd = &cobra.Command{
	Use:   "melodex",
	Short: "Melodex 音乐服务",
	RunE: func(cmd *cobra.Command, _ []string) error {
		if showVersion {
			fmt.Printf("Melodex v%s\n", core.AppVersion)
			return nil
		}
		return cmd.Help()
	},
}

func init() {
	rootCmd.Flags().BoolVarP(&showVersion, "version", "v", false, "显示版本信息")
}
