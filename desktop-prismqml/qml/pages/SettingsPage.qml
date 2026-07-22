// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Item {
    id: root

    Fluent.ScrollArea {
        objectName: "settingsScrollArea"
        anchors.fill: parent
        orientation: Qt.Vertical
        padding: Fluent.Enums.spacing.xxxl
        showScrollBar: true

        ColumnLayout {
            id: settingsContent
            objectName: "settingsContent"
            width: parent ? parent.width : 0
            spacing: Fluent.Enums.spacing.xl

            Fluent.Label {
                Layout.fillWidth: true
                type: Fluent.Enums.label.type_title
                text: "设置"
            }

            Fluent.SettingsCardGroup {
                Layout.fillWidth: true
                Layout.preferredHeight: implicitHeight
                title: "连接"

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_push
                    icon: Fluent.Enums.icon.server
                    title: "Melodex 服务"
                    content: UserSettings.serviceUrl
                    buttonText: "重新验证"
                    onClicked: Api.checkSession()
                }
            }

            Fluent.SettingsCardGroup {
                Layout.fillWidth: true
                Layout.preferredHeight: implicitHeight
                title: "桌面歌词"

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_switch
                    icon: Fluent.Enums.icon.desktop
                    title: "显示桌面歌词"
                    content: "播放时显示透明置顶歌词窗口"
                    checked: UserSettings.lyricsVisible
                    onToggled: enabled => UserSettings.setLyricsVisible(enabled)
                }

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_switch
                    icon: Fluent.Enums.icon.desktop_cursor
                    title: "鼠标穿透"
                    content: "允许鼠标操作歌词后方的窗口"
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
                    icon: Fluent.Enums.icon.person
                    title: Api.currentUser.username || "当前账户"
                    content: "退出后仍保留服务地址，不保留会话 cookie"
                    buttonText: "退出登录"
                    onClicked: Api.logout()
                }
            }

            Fluent.SettingsCardGroup {
                Layout.fillWidth: true
                Layout.preferredHeight: implicitHeight
                title: "关于"

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_push
                    icon: Fluent.Enums.icon.info
                    title: AppConfig.name + " Desktop"
                    content: "版本 " + AppConfig.version + "  ·  PrismQML 原生界面"
                }
            }
        }
    }
}
