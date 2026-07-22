// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Item {
    id: root

    signal openSearchRequested()

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Fluent.Enums.spacing.xxxl
        spacing: Fluent.Enums.spacing.xl

        Text {
            Layout.fillWidth: true
            text: "晚上好，" + (Api.currentUser.username || "Melodex 用户")
            color: Fluent.Enums.foregroundColor
            font.pixelSize: Fluent.Enums.typography.displayLarge
            font.bold: true
        }

        Text {
            Layout.fillWidth: true
            text: "桌面端已直接连接你的音乐服务。搜索一首歌，播放器和透明桌面歌词会一起工作。"
            color: Fluent.Enums.secondaryForeground
            font.pixelSize: Fluent.Enums.typography.bodyLarge
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.l

            Repeater {
                model: [
                    { title: "原生播放", detail: "Qt Multimedia 播放队列" },
                    { title: "透明歌词", detail: "逐字进度与鼠标穿透" },
                    { title: "保持连接", detail: "本机保存 Melodex 会话" }
                ]

                delegate: Fluent.Card {
                    required property var modelData
                    Layout.fillWidth: true
                    Layout.preferredHeight: 132
                    cardType: Fluent.Enums.card.type_elevated

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: Fluent.Enums.spacing.xl
                        spacing: Fluent.Enums.spacing.m

                        Text {
                            Layout.fillWidth: true
                            text: modelData.title
                            color: Fluent.Enums.foregroundColor
                            font.pixelSize: Fluent.Enums.typography.title
                            font.bold: true
                        }

                        Text {
                            Layout.fillWidth: true
                            text: modelData.detail
                            color: Fluent.Enums.secondaryForeground
                            font.pixelSize: Fluent.Enums.typography.body
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }
        }

        Fluent.Card {
            Layout.fillWidth: true
            Layout.preferredHeight: 210
            cardType: Fluent.Enums.card.type_default

            RowLayout {
                anchors.fill: parent
                anchors.margins: Fluent.Enums.spacing.xxxl
                spacing: Fluent.Enums.spacing.xxxl

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Fluent.Enums.spacing.l

                    Text {
                        Layout.fillWidth: true
                        text: "从搜索开始"
                        color: Fluent.Enums.foregroundColor
                        font.pixelSize: Fluent.Enums.typography.display
                        font.bold: true
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "结果顺序直接使用 Melodex 后端排序；选择歌曲后由桌面原生播放器接管。"
                        color: Fluent.Enums.secondaryForeground
                        font.pixelSize: Fluent.Enums.typography.body
                        wrapMode: Text.WordWrap
                    }

                    Fluent.Button {
                        Layout.preferredWidth: 150
                        Layout.preferredHeight: 42
                        text: "搜索音乐"
                        icon: Fluent.Enums.icon.search
                        style: Fluent.Enums.button.style_primary
                        onClicked: root.openSearchRequested()
                    }
                }

                Image {
                    Layout.preferredWidth: 150
                    Layout.preferredHeight: 150
                    source: AppConfig.iconUrl
                    fillMode: Image.PreserveAspectFit
                    opacity: 0.9
                }
            }
        }

        Item { Layout.fillHeight: true }

        Text {
            Layout.fillWidth: true
            text: "Melodex Desktop " + AppConfig.version + "  ·  PrismQML"
            color: Fluent.Enums.tertiaryForeground
            font.pixelSize: Fluent.Enums.typography.caption
        }
    }
}
