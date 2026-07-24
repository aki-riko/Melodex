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
        { text: "歌单", icon: Fluent.Enums.icon.collections },
        { text: "正在播放", icon: Fluent.Enums.icon.music_note_2 }
    ]

    Fluent.Windows {
        id: mainWindow
        objectName: "mainWindow"

        // C++ owns the first show() call. This follows PrismQML's public
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
        _splashInstance: startupSplash

        navigationItems: Api.authenticated ? root.navigationModel : []
        bottomNavigationItems: Api.authenticated ? [
            {
                text: Api.currentUser.username || "账户",
                icon: Fluent.Enums.icon.person,
                key: "page_4"
            }
        ] : []

        onCloseRequested: {
            closeRequestAccepted = false
            playbackQueueDrawer.close()
            hide()
        }

        onCurrentIndexChanged: {
            if (currentIndex !== 3)
                playbackQueueDrawer.close()
        }

        HomePage {
            objectName: "homePage"
            onOpenSearchRequested: mainWindow.currentIndex = 1
            onOpenPlaylistsRequested: mainWindow.currentIndex = 2
            onOpenPlayerRequested: mainWindow.currentIndex = 3
            onOpenSettingsRequested: mainWindow.currentIndex = 4
        }

        SearchPage {
            objectName: "searchPage"
            onOpenPlayerRequested: mainWindow.currentIndex = 3
        }

        PlaylistsPage {
            objectName: "playlistsPage"
            onOpenPlayerRequested: mainWindow.currentIndex = 3
        }

        NowPlayingPage {
            objectName: "nowPlayingPage"
            onQueueRequested: playbackQueueDrawer.open()
        }

        SettingsPage {
            objectName: "settingsPage"
        }
    }

    Fluent.SplashScreen {
        id: startupSplash
        objectName: "startupSplashScreen"
        parent: mainWindow.contentItem
        iconSource: AppConfig.iconUrl
        title: AppConfig.name
        subtitle: "正在载入桌面客户端"
    }

    PlaybackQueueDrawer {
        id: playbackQueueDrawer
        parent: mainWindow.contentItem
        anchors.fill: parent
    }

    Connections {
        target: Api

        function onAuthenticatedChanged() {
            mainWindow.currentIndex = 0
        }
    }

    DesktopLyricsWindow { }
}
