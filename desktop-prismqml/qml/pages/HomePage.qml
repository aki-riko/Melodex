// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Item {
    id: root

    signal openSearchRequested()
    signal openPlayerRequested()
    signal openSettingsRequested()

    LoginPage {
        anchors.fill: parent
        visible: !Api.authenticated
    }

    Flickable {
        anchors.fill: parent
        visible: Api.authenticated
        clip: true
        contentWidth: width
        contentHeight: dashboard.implicitHeight + Fluent.Enums.spacing.xxxl * 2
        boundsBehavior: Flickable.StopAtBounds

        ColumnLayout {
            id: dashboard
            x: Fluent.Enums.spacing.xxxl
            y: Fluent.Enums.spacing.xxxl
            width: parent.width - Fluent.Enums.spacing.xxxl * 2
            spacing: Fluent.Enums.spacing.xl

            RowLayout {
                Layout.fillWidth: true
                spacing: Fluent.Enums.spacing.l

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Fluent.Enums.spacing.xs

                    Fluent.Label {
                        Layout.fillWidth: true
                        type: Fluent.Enums.label.type_title
                        text: "概览"
                    }

                    Fluent.Label {
                        Layout.fillWidth: true
                        type: Fluent.Enums.label.type_body
                        text: "欢迎回来，" + (Api.currentUser.username || "Melodex 用户")
                        color: Fluent.Enums.secondaryForeground
                    }
                }

                Fluent.Tag {
                    status: Fluent.Enums.statusLevel.success
                    text: "服务已连接"
                }
            }

            Fluent.InfoBar {
                Layout.fillWidth: true
                Layout.preferredHeight: implicitHeight
                title: "当前服务"
                message: UserSettings.serviceUrl
                severity: "success"
                closable: false
            }

            Fluent.SettingsCardGroup {
                Layout.fillWidth: true
                Layout.preferredHeight: implicitHeight
                title: "开始"

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_primary_push
                    icon: Fluent.Enums.icon.search
                    title: "搜索音乐"
                    content: "搜索全网曲库并使用 Melodex 的相关性排序"
                    buttonText: "打开搜索"
                    onClicked: root.openSearchRequested()
                }

                Fluent.SettingsCard {
                    width: parent.width
                    visible: Boolean(Player.currentSong.id)
                    type: Fluent.Enums.settingCard.type_push
                    icon: Fluent.Enums.icon.music_note_2_play
                    title: Player.currentSong.name || "正在播放"
                    content: Player.currentSong.artist || "查看播放器与同步歌词"
                    buttonText: "查看"
                    onClicked: root.openPlayerRequested()
                }
            }

            Fluent.SettingsCardGroup {
                Layout.fillWidth: true
                Layout.preferredHeight: implicitHeight
                title: "桌面功能"

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_switch
                    icon: Fluent.Enums.icon.desktop
                    title: "桌面歌词"
                    content: "透明、无标题栏并始终置顶"
                    checked: UserSettings.lyricsVisible
                    onToggled: enabled => UserSettings.setLyricsVisible(enabled)
                }

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_switch
                    icon: Fluent.Enums.icon.desktop_cursor
                    title: "鼠标穿透"
                    content: "开启后点击会穿过歌词窗口"
                    checked: UserSettings.clickThrough
                    onToggled: enabled => UserSettings.setClickThrough(enabled)
                }
            }

            Fluent.SettingsCardGroup {
                Layout.fillWidth: true
                Layout.preferredHeight: implicitHeight
                title: "账户"

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_push
                    icon: Fluent.Enums.icon.person_settings
                    title: Api.currentUser.username || "当前账户"
                    content: "管理连接、桌面歌词和登录状态"
                    buttonText: "设置"
                    onClicked: root.openSettingsRequested()
                }
            }
        }
    }
}
