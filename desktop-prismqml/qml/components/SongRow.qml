// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Fluent.Card {
    id: root

    property var song: ({})
    property var queue: []
    signal playRequested(var song, var queue)

    width: ListView.view ? ListView.view.width : 720
    height: 72
    cardType: Fluent.Enums.card.type_hover
    clickEnabled: false

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: Fluent.Enums.spacing.l
        anchors.rightMargin: Fluent.Enums.spacing.l
        spacing: Fluent.Enums.spacing.l

        Rectangle {
            Layout.preferredWidth: 48
            Layout.preferredHeight: 48
            radius: Fluent.Enums.radius.medium
            color: Fluent.Enums.surfaceColor
            clip: true

            Text {
                anchors.centerIn: parent
                text: "♫"
                color: Fluent.Enums.secondaryForeground
                font.pixelSize: Fluent.Enums.typography.titleLarge
            }

            Image {
                anchors.fill: parent
                source: Api.coverUrl(root.song)
                asynchronous: true
                cache: true
                fillMode: Image.PreserveAspectCrop
                visible: status === Image.Ready
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.xxs

            Text {
                Layout.fillWidth: true
                text: root.song.name || "未知歌曲"
                color: Fluent.Enums.foregroundColor
                font.pixelSize: Fluent.Enums.typography.bodyLarge
                font.bold: true
                elide: Text.ElideRight
            }

            Text {
                Layout.fillWidth: true
                text: (root.song.artist || "未知歌手")
                      + (root.song.album ? "  ·  " + root.song.album : "")
                color: Fluent.Enums.secondaryForeground
                font.pixelSize: Fluent.Enums.typography.caption
                elide: Text.ElideRight
            }
        }

        Text {
            text: root.song.source || ""
            color: Fluent.Enums.tertiaryForeground
            font.pixelSize: Fluent.Enums.typography.caption
        }

        Fluent.Button {
            Layout.preferredWidth: 40
            Layout.preferredHeight: 40
            icon: Fluent.Enums.icon.play
            style: Fluent.Enums.button.style_primary
            shape: Fluent.Enums.button.shape_pill
            onClicked: root.playRequested(root.song, root.queue)
        }
    }
}
