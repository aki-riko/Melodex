@echo off
setlocal EnableExtensions

set "TASKS=%*"
if "%TASKS%"=="" set "TASKS=testDebugUnitTest assembleDebug"
if defined MELODEX_JAVA_HOME set "JAVA_HOME=%MELODEX_JAVA_HOME%"

for %%D in (Z Y X W V U T S R Q P O N M L K J I H G F E) do (
    if not exist %%D:\ (
        set "MELODEX_BUILD_DRIVE=%%D:"
        goto :drive_found
    )
)

echo No free drive letter is available for the Android build. 1>&2
exit /b 1

:drive_found
subst %MELODEX_BUILD_DRIVE% "%~dp0.."
if errorlevel 1 exit /b %errorlevel%

pushd %MELODEX_BUILD_DRIVE%\
if not exist node_modules\@capacitor\android (
    echo Missing root Capacitor dependencies. Run npm.cmd install in the repository root. 1>&2
    set "BUILD_EXIT_CODE=1"
    goto :cleanup
)
call npm.cmd run cap:copy
if errorlevel 1 (
    set "BUILD_EXIT_CODE=1"
    goto :cleanup
)
pushd android
call gradlew.bat %TASKS%
set "BUILD_EXIT_CODE=%errorlevel%"
popd

:cleanup
popd
subst %MELODEX_BUILD_DRIVE% /d
exit /b %BUILD_EXIT_CODE%
