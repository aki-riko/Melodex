// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import PrismQML as Fluent
import "components"
import "pages"

Item {
    id: root

    width: 0
    height: 0

    readonly property var navigationModel: [
        { text: "概览", icon: Fluent.Enums.icon.home },
        { text: "搜索", icon: Fluent.Enums.icon.search },
        { text: "正在播放", icon: Fluent.Enums.icon.music_note_2 }
    ]

    Fluent.Windows {
        id: mainWindow
        objectName: "mainWindow"

        // Python owns the first show() call. This follows PrismQML's public
        // window lifecycle and keeps the native HWND from remaining hidden.
        visible: false
        width: AppConfig.windowWidth
        height: AppConfig.windowHeight
        minimumWidth: AppConfig.minimumWindowWidth
        minimumHeight: AppConfig.minimumWindowHeight
        windowTitle: AppConfig.name
        windowIcon: AppConfig.iconUrl
        windowIconColored: true
        shadowMode: HeadlessSelfTest
                    ? Fluent.Enums.windowShadow.mode_none
                    : Fluent.Enums.windowShadow.mode_auto
        micaEnabled: !HeadlessSelfTest
        lazyLoading: false

        navigationItems: Api.authenticated ? root.navigationModel : []
        bottomNavigationItems: Api.authenticated ? [
            {
                text: Api.currentUser.username || "账户",
                icon: Fluent.Enums.icon.person,
                key: "page_3"
            }
        ] : []

        onCloseRequested: {
            closeRequestAccepted = false
            hide()
        }

        HomePage {
            objectName: "homePage"
            onOpenSearchRequested: mainWindow.currentIndex = 1
            onOpenPlayerRequested: mainWindow.currentIndex = 2
            onOpenSettingsRequested: mainWindow.currentIndex = 3
        }

        SearchPage {
            objectName: "searchPage"
            onOpenPlayerRequested: mainWindow.currentIndex = 2
        }

        NowPlayingPage {
            objectName: "nowPlayingPage"
        }

        SettingsPage {
            objectName: "settingsPage"
        }
    }

    Connections {
        target: Api

        function onAuthenticatedChanged() {
            mainWindow.currentIndex = 0
        }
    }

    DesktopLyricsWindow { }
}
