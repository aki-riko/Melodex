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
        return minutes + ":" + (rest < 10 ? "0" : "") + rest
    }

    Layout.fillWidth: true
    Layout.preferredHeight: 112
    cardType: Fluent.Enums.card.type_default

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Fluent.Enums.spacing.l
        spacing: Fluent.Enums.spacing.s

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.l

            Rectangle {
                Layout.preferredWidth: 52
                Layout.preferredHeight: 52
                radius: Fluent.Enums.radius.medium
                color: Fluent.Enums.surfaceColor
                clip: true

                Text {
                    anchors.centerIn: parent
                    text: "♫"
                    color: Fluent.Enums.secondaryForeground
                    font.pixelSize: Fluent.Enums.typography.display
                }

                Image {
                    anchors.fill: parent
                    source: Api.coverUrl(Player.currentSong)
                    asynchronous: true
                    cache: true
                    fillMode: Image.PreserveAspectCrop
                    visible: status === Image.Ready
                }
            }

            ColumnLayout {
                Layout.preferredWidth: 210
                Layout.maximumWidth: 260
                spacing: Fluent.Enums.spacing.xxs

                Text {
                    Layout.fillWidth: true
                    text: Player.currentSong.name || "尚未播放"
                    color: Fluent.Enums.foregroundColor
                    font.pixelSize: Fluent.Enums.typography.body
                    font.bold: true
                    elide: Text.ElideRight
                }

                Text {
                    Layout.fillWidth: true
                    text: Player.currentSong.artist || ""
                    color: Fluent.Enums.secondaryForeground
                    font.pixelSize: Fluent.Enums.typography.caption
                    elide: Text.ElideRight
                }
            }

            Fluent.Button {
                Layout.preferredWidth: 36
                Layout.preferredHeight: 36
                icon: Fluent.Enums.icon.previous
                shape: Fluent.Enums.button.shape_pill
                onClicked: Player.previous()
            }

            Fluent.Button {
                Layout.preferredWidth: 44
                Layout.preferredHeight: 44
                icon: Player.playing ? Fluent.Enums.icon.pause : Fluent.Enums.icon.play
                style: Fluent.Enums.button.style_primary
                shape: Fluent.Enums.button.shape_pill
                onClicked: Player.togglePlay()
            }

            Fluent.Button {
                Layout.preferredWidth: 36
                Layout.preferredHeight: 36
                icon: Fluent.Enums.icon.next
                shape: Fluent.Enums.button.shape_pill
                onClicked: Player.next()
            }

            Text {
                text: root.timeText(Player.position)
                color: Fluent.Enums.secondaryForeground
                font.pixelSize: Fluent.Enums.typography.caption
            }

            Fluent.Slider {
                id: positionSlider
                Layout.fillWidth: true
                from: 0
                to: Math.max(1, Player.duration)
                stepSize: 0.25
                onValueModified: value => Player.seek(value)

                Binding {
                    target: positionSlider
                    property: "value"
                    value: Player.position
                }
            }

            Text {
                text: root.timeText(Player.duration)
                color: Fluent.Enums.secondaryForeground
                font.pixelSize: Fluent.Enums.typography.caption
            }

            Fluent.Button {
                Layout.preferredWidth: 44
                Layout.preferredHeight: 36
                icon: Fluent.Enums.icon.window
                style: UserSettings.lyricsVisible
                       ? Fluent.Enums.button.style_primary
                       : Fluent.Enums.button.style_default
                onClicked: DesktopState.toggleLyricsVisible()
            }

            Fluent.Slider {
                id: volumeSlider
                Layout.preferredWidth: 90
                from: 0
                to: 1
                stepSize: 0.01
                onValueModified: value => Player.setVolume(value)

                Binding {
                    target: volumeSlider
                    property: "value"
                    value: Player.volume
                }
            }
        }

        Text {
            Layout.fillWidth: true
            visible: Boolean(Player.error)
            text: Player.error
            color: Fluent.Enums.infoAccentColor
            font.pixelSize: Fluent.Enums.typography.caption
            elide: Text.ElideRight
        }
    }
}
