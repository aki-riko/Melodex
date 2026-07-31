// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Fluent.Card {
    id: root

    signal expandRequested()
    signal queueRequested()

    property bool expandEnabled: true
    property bool queueEnabled: true
    readonly property int coverSize: Fluent.Enums.controlSize.navItemHeight
                                     + Fluent.Enums.spacing.xs
    readonly property int lyricIndex: Player.currentLyricIndex
    readonly property string contextText: {
        if (Player.error)
            return "播放失败 · " + Player.error
        if (lyricIndex >= 0 && lyricIndex < Player.lyrics.length)
            return Player.lyrics[lyricIndex].text || ""
        return Player.currentSong.artist || "未知歌手"
    }

    function timeText(seconds) {
        const safe = Math.max(0, Math.floor(seconds || 0))
        const minutes = Math.floor(safe / 60)
        const rest = safe % 60
        return (minutes < 10 ? "0" : "") + minutes
               + ":" + (rest < 10 ? "0" : "") + rest
    }

    implicitHeight: coverSize + Fluent.Enums.spacing.l * 2
    cardType: Fluent.Enums.card.type_elevated
    clickEnabled: expandEnabled && Boolean(Player.currentSong.id)
    contentPadding: Fluent.Enums.spacing.l
    onClicked: root.expandRequested()

    RowLayout {
        anchors.fill: parent
        spacing: Fluent.Enums.spacing.m

        Fluent.ImageWidget {
            objectName: "playerBarCover"
            Layout.preferredWidth: root.coverSize
            Layout.preferredHeight: root.coverSize
            Layout.alignment: Qt.AlignVCenter
            radius: Fluent.Enums.radius.medium
            source: Api.coverUrl(Player.currentSong)
            fillMode: Image.PreserveAspectCrop
            onClicked: {
                if (root.expandEnabled && Player.currentSong.id)
                    root.expandRequested()
            }
        }

        ColumnLayout {
            Layout.preferredWidth: 210
            Layout.minimumWidth: 150
            Layout.maximumWidth: 260
            Layout.alignment: Qt.AlignVCenter
            spacing: Fluent.Enums.spacing.xxs

            Fluent.Marquee {
                Layout.fillWidth: true
                Layout.preferredHeight: 24
                text: Player.currentSong.name || "尚未播放"
                labelType: Fluent.Enums.label.type_body_strong
                running: Player.playing
                customTextColor: Fluent.Enums.textColor.primary
            }

            Fluent.Label {
                Layout.fillWidth: true
                type: Fluent.Enums.label.type_caption
                text: root.contextText
                color: Player.error
                       ? Fluent.Enums.statusLevel.getColorByLevel(
                             Fluent.Enums.statusLevel.error
                         )
                       : Fluent.Enums.secondaryForeground
                wrapMode: Text.NoWrap
                maximumLineCount: 1
                elide: Text.ElideRight
            }
        }

        Fluent.Button {
            Layout.preferredWidth: 38
            Layout.preferredHeight: 38
            Layout.alignment: Qt.AlignVCenter
            icon: Fluent.Enums.icon.previous
            style: Fluent.Enums.button.style_transparent
            shape: Fluent.Enums.button.shape_pill
            enabled: Boolean(Player.currentSong.id)
            toolTipText: "上一首"
            onClicked: Player.previous()
        }

        Fluent.Button {
            Layout.preferredWidth: 46
            Layout.preferredHeight: 46
            Layout.alignment: Qt.AlignVCenter
            icon: Player.playing ? Fluent.Enums.icon.pause : Fluent.Enums.icon.play
            style: Fluent.Enums.button.style_primary
            shape: Fluent.Enums.button.shape_pill
            enabled: Boolean(Player.currentSong.id)
            toolTipText: Player.playing ? "暂停" : "播放"
            onClicked: Player.togglePlay()
        }

        Fluent.Button {
            Layout.preferredWidth: 38
            Layout.preferredHeight: 38
            Layout.alignment: Qt.AlignVCenter
            icon: Fluent.Enums.icon.next
            style: Fluent.Enums.button.style_transparent
            shape: Fluent.Enums.button.shape_pill
            enabled: Boolean(Player.currentSong.id)
            toolTipText: "下一首"
            onClicked: Player.next()
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.minimumWidth: 180
            Layout.preferredHeight: 46
            Layout.alignment: Qt.AlignVCenter
            spacing: Fluent.Enums.spacing.s

            Fluent.Label {
                Layout.alignment: Qt.AlignVCenter
                type: Fluent.Enums.label.type_caption
                text: root.timeText(Player.position)
                color: Fluent.Enums.secondaryForeground
            }

            Fluent.Slider {
                id: positionSlider
                Layout.fillWidth: true
                Layout.alignment: Qt.AlignVCenter
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
                Layout.alignment: Qt.AlignVCenter
                type: Fluent.Enums.label.type_caption
                text: root.timeText(Player.duration)
                color: Fluent.Enums.secondaryForeground
            }
        }

        RowLayout {
            visible: root.width >= 900
            Layout.preferredWidth: visible ? 112 : 0
            Layout.preferredHeight: 46
            Layout.alignment: Qt.AlignVCenter
            spacing: Fluent.Enums.spacing.xs

            Fluent.Icon {
                Layout.alignment: Qt.AlignVCenter
                icon: Fluent.Enums.icon.speaker_2
                iconSize: Fluent.Enums.iconSize.s
                color: Fluent.Enums.secondaryForeground
            }

            Fluent.Slider {
                id: volumeSlider
                Layout.fillWidth: true
                Layout.alignment: Qt.AlignVCenter
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
        }

        Fluent.Button {
            Layout.preferredWidth: 38
            Layout.preferredHeight: 38
            Layout.alignment: Qt.AlignVCenter
            icon: Fluent.Enums.icon.desktop
            style: UserSettings.lyricsVisible
                   ? Fluent.Enums.button.style_primary
                   : Fluent.Enums.button.style_transparent
            shape: Fluent.Enums.button.shape_pill
            toolTipText: UserSettings.lyricsVisible ? "隐藏桌面歌词" : "显示桌面歌词"
            onClicked: DesktopState.toggleLyricsVisible()
        }

        Fluent.Button {
            visible: root.queueEnabled
            Layout.preferredWidth: visible ? 38 : 0
            Layout.preferredHeight: 38
            Layout.alignment: Qt.AlignVCenter
            icon: Fluent.Enums.icon.collections
            style: Fluent.Enums.button.style_transparent
            shape: Fluent.Enums.button.shape_pill
            enabled: Player.queue.length > 0
            toolTipText: "播放队列（" + Player.queue.length + "）"
            onClicked: root.queueRequested()
        }
    }
}
