// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Fluent.Card {
    id: root

    function timeText(seconds) {
        const safe = Math.max(0, Math.floor(seconds || 0))
        const minutes = Math.floor(safe / 60)
        const rest = safe % 60
        return (minutes < 10 ? "0" : "") + minutes
               + ":" + (rest < 10 ? "0" : "") + rest
    }

    implicitWidth: 420
    implicitHeight: 540
    cardType: Fluent.Enums.card.type_elevated

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Fluent.Enums.spacing.xxl
        spacing: Fluent.Enums.spacing.l

        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.minimumHeight: 180

            Fluent.ImageWidget {
                anchors.centerIn: parent
                width: Math.min(parent.width, parent.height, 260)
                height: width
                radius: Fluent.Enums.radius.large
                source: Api.coverUrl(Player.currentSong)
                fillMode: Image.PreserveAspectCrop
            }
        }

        Fluent.Label {
            Layout.fillWidth: true
            type: Fluent.Enums.label.type_subtitle
            text: Player.currentSong.name || "尚未播放"
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
        }

        Fluent.Label {
            Layout.fillWidth: true
            type: Fluent.Enums.label.type_body
            text: Player.currentSong.artist || "从搜索页选择一首歌曲"
            color: Fluent.Enums.secondaryForeground
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
        }

        RowLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: Fluent.Enums.spacing.l

            Fluent.Button {
                Layout.preferredWidth: 42
                Layout.preferredHeight: 42
                icon: Fluent.Enums.icon.previous
                shape: Fluent.Enums.button.shape_pill
                enabled: Boolean(Player.currentSong.id)
                onClicked: Player.previous()
            }

            Fluent.Button {
                Layout.preferredWidth: 54
                Layout.preferredHeight: 54
                icon: Player.playing ? Fluent.Enums.icon.pause : Fluent.Enums.icon.play
                style: Fluent.Enums.button.style_primary
                shape: Fluent.Enums.button.shape_pill
                enabled: Boolean(Player.currentSong.id)
                onClicked: Player.togglePlay()
            }

            Fluent.Button {
                Layout.preferredWidth: 42
                Layout.preferredHeight: 42
                icon: Fluent.Enums.icon.next
                shape: Fluent.Enums.button.shape_pill
                enabled: Boolean(Player.currentSong.id)
                onClicked: Player.next()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.m

            Fluent.Label {
                type: Fluent.Enums.label.type_caption
                text: root.timeText(Player.position)
                color: Fluent.Enums.secondaryForeground
            }

            Fluent.Slider {
                id: positionSlider
                Layout.fillWidth: true
                from: 0
                to: Math.max(1, Player.duration)
                stepSize: 0.25
                displayValueFn: value => root.timeText(value)
                enabled: Boolean(Player.currentSong.id)
                onValueModified: value => Player.seek(value)

                Binding {
                    target: positionSlider
                    property: "value"
                    value: Player.position
                }
            }

            Fluent.Label {
                type: Fluent.Enums.label.type_caption
                text: root.timeText(Player.duration)
                color: Fluent.Enums.secondaryForeground
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.m

            Fluent.Icon {
                icon: Fluent.Enums.icon.speaker_2
                iconSize: Fluent.Enums.iconSize.m
                color: Fluent.Enums.secondaryForeground
            }

            Fluent.Slider {
                id: volumeSlider
                Layout.fillWidth: true
                from: 0
                to: 1
                stepSize: 0.01
                displayValueFn: value => Math.round(value * 100) + "%"
                onValueModified: value => Player.setVolume(value)

                Binding {
                    target: volumeSlider
                    property: "value"
                    value: Player.volume
                }
            }

            Fluent.Button {
                text: UserSettings.lyricsVisible ? "隐藏桌面歌词" : "显示桌面歌词"
                icon: Fluent.Enums.icon.desktop
                style: UserSettings.lyricsVisible
                       ? Fluent.Enums.button.style_primary
                       : Fluent.Enums.button.style_default
                onClicked: DesktopState.toggleLyricsVisible()
            }
        }

        Fluent.InfoBar {
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? implicitHeight : 0
            visible: Boolean(Player.error)
            title: "播放失败"
            message: Player.error
            severity: "error"
            closable: false
        }
    }
}
