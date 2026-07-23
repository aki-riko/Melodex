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
                    title: "锁定桌面歌词"
                    content: "锁定后鼠标会穿透歌词；可从系统托盘或这里解锁"
                    checked: UserSettings.clickThrough
                    onToggled: enabled => UserSettings.setClickThrough(enabled)
                }

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_range
                    icon: Fluent.Enums.icon.music_note_2
                    title: "字体与字号"
                    content: "微软雅黑 UI（固定） · 当前 "
                             + UserSettings.lyricsFontSize + " px"
                    value: UserSettings.lyricsFontSize
                    from: UserSettings.lyricsFontSizeMinimum
                    to: UserSettings.lyricsFontSizeMaximum
                    stepSize: 1
                    onRangeChanged: value => UserSettings.setLyricsFontSize(
                                        Math.round(value)
                                    )
                }

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_combobox
                    icon: Fluent.Enums.icon.music_note_2_play
                    title: "配色方案"
                    content: "方案同时确定已播放与未播放歌词颜色"
                    model: UserSettings.lyricsColorSchemeNames
                    currentIndex: UserSettings.lyricsColorSchemeIndex
                    onIndexSelected: index => UserSettings.setLyricsColorSchemeIndex(
                                         index
                                     )
                }

                Fluent.SettingsCard {
                    width: parent.width
                    type: Fluent.Enums.settingCard.type_push
                    icon: Fluent.Enums.icon.desktop
                    title: "桌面歌词位置"
                    content: UserSettings.lyricsPositionSet
                             ? "已保存到 " + UserSettings.lyricsX + ", "
                               + UserSettings.lyricsY
                             : "解锁后拖动歌词窗口即可自动保存"
                    buttonText: "重置位置"
                    onClicked: UserSettings.resetLyricsPosition()
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
