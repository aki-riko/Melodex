package core

const AppVersion string = "1.0.30"

type ReleaseMetadata struct {
	Application string
	Version     string
}

func CurrentRelease() ReleaseMetadata {
	return ReleaseMetadata{Application: "Melodex", Version: AppVersion}
}
