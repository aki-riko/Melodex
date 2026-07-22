cmake_minimum_required(VERSION 3.21)

project(MelodexDesktop VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.9 REQUIRED COMPONENTS
    Core Gui Multimedia Network Qml Quick Test Widgets)
find_package(prism CONFIG REQUIRED)

qt_standard_project_setup()

add_library(melodex_desktop_core STATIC
    cpp/ApplicationConfig.cpp
    cpp/ApiClient.cpp
    cpp/CollectionController.cpp
    cpp/CookieStore.cpp
    cpp/DesktopState.cpp
    cpp/JsonUtils.cpp
    cpp/Lyrics.cpp
    cpp/PlaybackStateStore.cpp
    cpp/PlayerController.cpp
    cpp/PlayerPersistence.cpp
    cpp/UserSettings.cpp
    cpp/include/melodex/ApplicationConfig.h
    cpp/include/melodex/ApiClient.h
    cpp/include/melodex/CollectionController.h
    cpp/include/melodex/CookieStore.h
    cpp/include/melodex/DesktopState.h
    cpp/include/melodex/JsonUtils.h
    cpp/include/melodex/Lyrics.h
    cpp/include/melodex/PlaybackStateStore.h
    cpp/include/melodex/PlayerController.h
    cpp/include/melodex/UserSettings.h
)
target_include_directories(melodex_desktop_core PUBLIC cpp/include)
target_link_libraries(melodex_desktop_core PUBLIC
    Qt6::Core Qt6::Gui Qt6::Multimedia Qt6::Network Qt6::Qml Qt6::Quick)

qt_add_executable(melodex_desktop cpp/main.cpp)
target_link_libraries(melodex_desktop PRIVATE
    melodex_desktop_core prism::prism Qt6::Widgets)
set_target_properties(melodex_desktop PROPERTIES
    QT_QML_MODULE_NO_IMPORT_SCAN TRUE)
target_compile_definitions(melodex_desktop PRIVATE
    PRISM_QML_DIR="${prism_QML_DIR}")

set(MELODEX_QML_FILES
    qml/main.qml
    qml/components/DesktopLyricsWindow.qml
    qml/components/PlayerBar.qml
    qml/components/SongRow.qml
    qml/components/WordFill.qml
    qml/pages/HomePage.qml
    qml/pages/LoginPage.qml
    qml/pages/NowPlayingPage.qml
    qml/pages/PlaylistsPage.qml
    qml/pages/SearchPage.qml
    qml/pages/SettingsPage.qml
)
qt_add_resources(melodex_desktop "melodex_resources"
    PREFIX "/Melodex"
    FILES app_config.json ${MELODEX_QML_FILES})

set_source_files_properties(
    "${CMAKE_CURRENT_SOURCE_DIR}/../frontend/public/logo512.png"
    PROPERTIES QT_RESOURCE_ALIAS "assets/logo512.png")
qt_add_resources(melodex_desktop "melodex_logo"
    PREFIX "/Melodex"
    FILES "${CMAKE_CURRENT_SOURCE_DIR}/../frontend/public/logo512.png")

if(MSVC)
    target_compile_options(melodex_desktop_core PRIVATE /utf-8 /W4)
    target_compile_options(melodex_desktop PRIVATE /utf-8 /W4)
endif()

include(CTest)
if(BUILD_TESTING)
    qt_add_executable(melodex_desktop_tests
        cpp/tests/test_contracts.cpp)
    qt_add_resources(melodex_desktop_tests "melodex_test_resources"
        PREFIX "/Melodex"
        FILES app_config.json)
    target_link_libraries(melodex_desktop_tests PRIVATE
        melodex_desktop_core Qt6::Test)
    set_target_properties(melodex_desktop_tests PROPERTIES
        QT_QML_MODULE_NO_IMPORT_SCAN TRUE)
    if(MSVC)
        target_compile_options(melodex_desktop_tests PRIVATE /utf-8 /W4)
    endif()
    set(MELODEX_TEST_PATH
        "$<TARGET_FILE_DIR:Qt6::Core>$<SEMICOLON>$<TARGET_FILE_DIR:Qt6::Multimedia>$<SEMICOLON>$ENV{PATH}")
    set(MELODEX_TEST_PLUGIN_PATH
        "$<TARGET_FILE_DIR:Qt6::Core>/../plugins$<SEMICOLON>$<TARGET_FILE_DIR:Qt6::Multimedia>/../plugins")
    add_test(NAME melodex_desktop_contracts
        COMMAND "${CMAKE_COMMAND}" -E env
            "QT_QPA_PLATFORM=offscreen"
            "QT_PLUGIN_PATH=${MELODEX_TEST_PLUGIN_PATH}"
            "PATH=${MELODEX_TEST_PATH}"
            "$<TARGET_FILE:melodex_desktop_tests>")

    add_test(NAME melodex_desktop_qml_selftest
        COMMAND "${CMAKE_COMMAND}" -E env
            "QT_QPA_PLATFORM=offscreen"
            "MELODEX_DESKTOP_SELFTEST=1"
            "QT_PLUGIN_PATH=${MELODEX_TEST_PLUGIN_PATH}"
            "PATH=${MELODEX_TEST_PATH}"
            "$<TARGET_FILE:melodex_desktop>")
    set_tests_properties(melodex_desktop_qml_selftest PROPERTIES TIMEOUT 30)

    qt_add_executable(melodex_playback_probe
        cpp/tests/playback_probe.cpp)
    target_link_libraries(melodex_playback_probe PRIVATE
        melodex_desktop_core)
    set_target_properties(melodex_playback_probe PROPERTIES
        QT_QML_MODULE_NO_IMPORT_SCAN TRUE)
    if(MSVC)
        target_compile_options(melodex_playback_probe PRIVATE /utf-8 /W4)
    endif()
endif()

install(TARGETS melodex_desktop RUNTIME DESTINATION bin BUNDLE DESTINATION .)

if(NOT EXISTS "${prism_QML_DIR}/PrismQML/qmldir")
    message(FATAL_ERROR
        "prism_QML_DIR does not contain a deployable PrismQML module: ${prism_QML_DIR}")
endif()
install(DIRECTORY "${prism_QML_DIR}/PrismQML" DESTINATION bin/qml)
