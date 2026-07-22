// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Fluent.Card {
    id: root
    objectName: "songRow"

    property var song: ({})
    property var queue: []
    signal playRequested(var song, var queue)

    function timeText(seconds) {
        const value = Math.max(0, Math.floor(seconds || 0))
        const minutes = Math.floor(value / 60)
        const rest = value % 60
        return minutes + ":" + (rest < 10 ? "0" : "") + rest
    }

    width: ListView.view ? ListView.view.width : 720
    height: 68
    cardType: Fluent.Enums.card.type_hover
    clickEnabled: false

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: Fluent.Enums.spacing.l
        anchors.rightMargin: Fluent.Enums.spacing.l
        spacing: Fluent.Enums.spacing.l

        Fluent.ImageWidget {
            Layout.preferredWidth: 44
            Layout.preferredHeight: 44
            radius: Fluent.Enums.radius.medium
            source: Api.coverUrl(root.song)
            fillMode: Image.PreserveAspectCrop
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.xxs

            Fluent.Label {
                Layout.fillWidth: true
                type: Fluent.Enums.label.type_body_strong
                text: root.song.name || "未知歌曲"
                elide: Text.ElideRight
            }

            Fluent.Label {
                Layout.fillWidth: true
                type: Fluent.Enums.label.type_caption
                text: (root.song.artist || "未知歌手")
                      + (root.song.album ? "  ·  " + root.song.album : "")
                color: Fluent.Enums.secondaryForeground
                elide: Text.ElideRight
            }
        }

        Fluent.Label {
            Layout.preferredWidth: 48
            type: Fluent.Enums.label.type_caption
            text: root.timeText(root.song.duration)
            color: Fluent.Enums.tertiaryForeground
            horizontalAlignment: Text.AlignRight
        }

        Fluent.Tag {
            status: Fluent.Enums.statusLevel.info
            text: String(root.song.source || "来源").toUpperCase()
            showDot: false
        }

        Fluent.Button {
            Layout.preferredWidth: 38
            Layout.preferredHeight: 38
            icon: Fluent.Enums.icon.play
            style: Fluent.Enums.button.style_primary
            shape: Fluent.Enums.button.shape_pill
            toolTipText: "播放"
            onClicked: root.playRequested(root.song, root.queue)
        }
    }
}
