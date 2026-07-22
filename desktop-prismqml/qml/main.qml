// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent
import "components"
import "pages"

Item {
    id: root

    property int currentPage: 0

    width: 0
    height: 0

    Fluent.WindowsCore {
        id: mainWindow
        objectName: "mainWindow"

        // Python owns the initial show call so the native HWND cannot remain
        // hidden after PrismQML finishes attaching its Windows frame hook.
        visible: false
        width: AppConfig.windowWidth
        height: AppConfig.windowHeight
        minimumWidth: AppConfig.minimumWindowWidth
        minimumHeight: AppConfig.minimumWindowHeight
        windowTitle: AppConfig.name
        windowIcon: AppConfig.iconUrl
        windowIconColored: true
        windowColor: Fluent.Enums.backgroundColor
        shadowMode: HeadlessSelfTest
                    ? Fluent.Enums.windowShadow.mode_none
                    : Fluent.Enums.windowShadow.mode_auto

        onCloseRequested: {
            closeRequestAccepted = false
            hide()
        }

        Rectangle {
            anchors.fill: parent
            color: Fluent.Enums.backgroundColor

            RowLayout {
                anchors.fill: parent
                spacing: Fluent.Enums.spacing.none

                Rectangle {
                    Layout.preferredWidth: Api.authenticated ? 220 : 0
                    Layout.fillHeight: true
                    visible: Api.authenticated
                    color: Fluent.Enums.surfaceColor

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: Fluent.Enums.spacing.l
                        spacing: Fluent.Enums.spacing.m

                        RowLayout {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 64
                            spacing: Fluent.Enums.spacing.l

                            Image {
                                Layout.preferredWidth: 40
                                Layout.preferredHeight: 40
                                source: AppConfig.iconUrl
                                fillMode: Image.PreserveAspectFit
                            }

                            Text {
                                Layout.fillWidth: true
                                text: AppConfig.name
                                color: Fluent.Enums.foregroundColor
                                font.pixelSize: Fluent.Enums.typography.titleLarge
                                font.bold: true
                            }
                        }

                        Fluent.Button {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 42
                            text: "首页"
                            icon: Fluent.Enums.icon.home
                            contentAlignment: Fluent.Enums.button.align_left
                            style: root.currentPage === 0
                                   ? Fluent.Enums.button.style_primary
                                   : Fluent.Enums.button.style_transparent
                            onClicked: root.currentPage = 0
                        }

                        Fluent.Button {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 42
                            text: "搜索"
                            icon: Fluent.Enums.icon.search
                            contentAlignment: Fluent.Enums.button.align_left
                            style: root.currentPage === 1
                                   ? Fluent.Enums.button.style_primary
                                   : Fluent.Enums.button.style_transparent
                            onClicked: root.currentPage = 1
                        }

                        Fluent.Button {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 42
                            text: "桌面歌词"
                            icon: Fluent.Enums.icon.window
                            contentAlignment: Fluent.Enums.button.align_left
                            style: UserSettings.lyricsVisible
                                   ? Fluent.Enums.button.style_primary
                                   : Fluent.Enums.button.style_transparent
                            onClicked: DesktopState.toggleLyricsVisible()
                        }

                        Item { Layout.fillHeight: true }

                        Text {
                            Layout.fillWidth: true
                            text: Api.currentUser.username || ""
                            color: Fluent.Enums.foregroundColor
                            font.pixelSize: Fluent.Enums.typography.body
                            font.bold: true
                            elide: Text.ElideRight
                        }

                        Text {
                            Layout.fillWidth: true
                            text: UserSettings.serviceUrl
                            color: Fluent.Enums.tertiaryForeground
                            font.pixelSize: Fluent.Enums.typography.captionCompact
                            elide: Text.ElideMiddle
                        }

                        Fluent.Button {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 38
                            text: "退出登录"
                            icon: Fluent.Enums.icon.sign_out
                            contentAlignment: Fluent.Enums.button.align_left
                            style: Fluent.Enums.button.style_transparent
                            onClicked: Api.logout()
                        }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: Fluent.Enums.spacing.l

                    Item {
                        Layout.fillWidth: true
                        Layout.fillHeight: true

                        LoginPage {
                            anchors.fill: parent
                            visible: !Api.authenticated
                        }

                        HomePage {
                            anchors.fill: parent
                            visible: Api.authenticated && root.currentPage === 0
                            onOpenSearchRequested: root.currentPage = 1
                        }

                        SearchPage {
                            anchors.fill: parent
                            visible: Api.authenticated && root.currentPage === 1
                        }
                    }

                    PlayerBar {
                        Layout.leftMargin: Fluent.Enums.spacing.l
                        Layout.rightMargin: Fluent.Enums.spacing.l
                        Layout.bottomMargin: Fluent.Enums.spacing.l
                        visible: Api.authenticated && Boolean(Player.currentSong.id)
                    }
                }
            }
        }
    }

    DesktopLyricsWindow { }
}
