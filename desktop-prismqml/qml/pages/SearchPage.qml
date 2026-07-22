// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent
import "../components"

Item {
    id: root

    function submit() {
        Api.search(searchInput.text)
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Fluent.Enums.spacing.xxxl
        spacing: Fluent.Enums.spacing.l

        Text {
            Layout.fillWidth: true
            text: "搜索音乐"
            color: Fluent.Enums.foregroundColor
            font.pixelSize: Fluent.Enums.typography.displayLarge
            font.bold: true
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.m

            Fluent.LineEdit {
                id: searchInput
                Layout.fillWidth: true
                Layout.preferredHeight: 42
                inputType: Fluent.Enums.input.type_search
                placeholderText: "输入歌名或歌手"
                onAccepted: root.submit()
                onSearched: text => Api.search(text)
            }

            Fluent.Button {
                Layout.preferredWidth: 110
                Layout.preferredHeight: 42
                text: "搜索"
                icon: Fluent.Enums.icon.search
                style: Fluent.Enums.button.style_primary
                loading: Api.busy
                enabled: !Api.busy
                onClicked: root.submit()
            }
        }

        Text {
            Layout.fillWidth: true
            visible: Boolean(Api.error)
            text: Api.error
            color: Fluent.Enums.infoAccentColor
            font.pixelSize: Fluent.Enums.typography.caption
            wrapMode: Text.WordWrap
        }

        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            ListView {
                id: resultList
                anchors.fill: parent
                clip: true
                spacing: Fluent.Enums.spacing.m
                model: Api.searchResults

                delegate: SongRow {
                    required property var modelData
                    song: modelData
                    queue: Api.searchResults
                    onPlayRequested: (song, queue) => Player.playSong(song, queue)
                }
            }

            Text {
                anchors.centerIn: parent
                width: Math.min(520, parent.width - Fluent.Enums.spacing.xxxl * 2)
                visible: !Api.busy && Api.searchResults.length === 0
                text: "输入关键词开始搜索，结果会按 Melodex 的相关性顺序显示。"
                color: Fluent.Enums.secondaryForeground
                font.pixelSize: Fluent.Enums.typography.bodyLarge
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
            }
        }
    }
}
