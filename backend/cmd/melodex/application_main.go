package main

import (
	"fmt"
	"io"
	"os"
)

func main() {
	if exitCode := executeApplication(os.Stderr); exitCode != 0 {
		os.Exit(exitCode)
	}
}

func executeApplication(errorOutput io.Writer) int {
	if err := rootCmd.Execute(); err != nil {
		writeApplicationError(errorOutput, err)
		return 1
	}
	return 0
}

func writeApplicationError(destination io.Writer, err error) {
	if destination == nil || err == nil {
		return
	}
	_, _ = fmt.Fprintf(destination, "Melodex command failed: %v\n", err)
}
