@{
    # Copy this file to run-local.config.psd1 and replace the two placeholders.
    QtRoot = '<Qt 6 MSVC root>'
    VsDevShell = '<Launch-VsDevShell.ps1 path>'

    # Relative paths are resolved from desktop-prismqml.
    PrismSdkRoot = '.\.prism-sdk\<PrismQML SDK directory>'

    # Optional. These stable defaults keep build and deployment output outside
    # the repository and avoid creating a new temporary directory per run.
    BuildDir = '%LOCALAPPDATA%\Melodex\desktop-build'
    DeployDir = '%LOCALAPPDATA%\Melodex\desktop-deploy'
}
