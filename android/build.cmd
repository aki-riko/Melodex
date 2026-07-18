@echo off
setlocal EnableExtensions

set "TASKS=%*"
if "%TASKS%"=="" set "TASKS=testDebugUnitTest assembleDebug"

for %%D in (Z Y X W V U T S R Q P O N M L K J I H G F E) do (
    if not exist %%D:\ (
        set "MELODEX_BUILD_DRIVE=%%D:"
        goto :drive_found
    )
)

echo No free drive letter is available for the Android build. 1>&2
exit /b 1

:drive_found
subst %MELODEX_BUILD_DRIVE% "%~dp0"
if errorlevel 1 exit /b %errorlevel%

pushd %MELODEX_BUILD_DRIVE%\
call gradlew.bat %TASKS%
set "BUILD_EXIT_CODE=%errorlevel%"
popd

subst %MELODEX_BUILD_DRIVE% /d
exit /b %BUILD_EXIT_CODE%
