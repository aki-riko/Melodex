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
        { text: "歌单", icon: Fluent.Enums.icon.collections }
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
                key: "page_3"
            }
        ] : []

        onCloseRequested: {
            closeRequestAccepted = false
            playbackQueueDrawer.close()
            nowPlayingDrawer.close()
            hide()
        }

        onCurrentIndexChanged: {
            playbackQueueDrawer.close()
        }

        HomePage {
            objectName: "homePage"
            onOpenSearchRequested: mainWindow.currentIndex = 1
            onOpenPlaylistsRequested: mainWindow.currentIndex = 2
            onOpenSettingsRequested: mainWindow.currentIndex = 3
        }

        SearchPage {
            objectName: "searchPage"
        }

        PlaylistsPage {
            objectName: "playlistsPage"
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

    Binding {
        target: mainWindow.stackedWidget
        property: "anchors.bottomMargin"
        value: globalPlayerBar.visible
               ? globalPlayerBar.height + Fluent.Enums.spacing.l * 2
               : 0
        when: mainWindow.stackedWidget !== null
        restoreMode: Binding.RestoreBinding
    }

    PlayerBar {
        id: globalPlayerBar
        objectName: "globalPlayerBar"
        parent: mainWindow.stackedWidget
                ? mainWindow.stackedWidget.parent
                : mainWindow.contentItem
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: Fluent.Enums.spacing.l
        height: implicitHeight
        visible: Api.authenticated && Boolean(Player.currentSong.id)
        z: Fluent.Enums.zIndex.popup
        onExpandRequested: nowPlayingDrawer.open()
        onQueueRequested: playbackQueueDrawer.open()
    }

    Fluent.Drawer {
        id: nowPlayingDrawer
        objectName: "nowPlayingDrawer"
        parent: mainWindow.contentItem
        anchors.fill: parent
        anchors.topMargin: mainWindow.titleBarHeight
        position: Fluent.Enums.position.bottom
        drawerHeight: height
        modal: true
        animationDuration: Fluent.Enums.duration.slow

        NowPlayingPage {
            objectName: "nowPlayingPage"
            anchors.fill: parent
            active: nowPlayingDrawer.opened
            onCloseRequested: nowPlayingDrawer.close()
            onQueueRequested: playbackQueueDrawer.open()
        }

        onClosed: playbackQueueDrawer.close()
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
            if (!Api.authenticated) {
                nowPlayingDrawer.close()
                playbackQueueDrawer.close()
            }
        }
    }

    DesktopLyricsWindow { }
}
