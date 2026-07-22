// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent
import "../components"

Item {
    id: root

    signal openPlayerRequested()

    function submit() {
        Api.search(searchInput.text)
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Fluent.Enums.spacing.xxxl
        spacing: Fluent.Enums.spacing.l

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.l

            ColumnLayout {
                Layout.fillWidth: true
                spacing: Fluent.Enums.spacing.xs

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_title
                    text: "搜索"
                }

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_body
                    text: "结果直接采用 Melodex 后端排序"
                    color: Fluent.Enums.secondaryForeground
                }
            }

            Fluent.Tag {
                visible: Api.searchResults.length > 0
                status: Fluent.Enums.statusLevel.info
                text: Api.searchResults.length + " 首"
            }

            Fluent.Button {
                visible: Boolean(Player.currentSong.id)
                text: "正在播放"
                icon: Fluent.Enums.icon.music_note_2_play
                onClicked: root.openPlayerRequested()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.m

            Fluent.LineEdit {
                id: searchInput
                Layout.fillWidth: true
                inputType: Fluent.Enums.input.type_search
                placeholderText: "输入歌名或歌手"
                onAccepted: root.submit()
                onSearched: text => Api.search(text)
            }

            Fluent.Button {
                Layout.preferredWidth: 108
                text: "搜索"
                icon: Fluent.Enums.icon.search
                style: Fluent.Enums.button.style_primary
                loading: Api.busy
                enabled: !Api.busy
                onClicked: root.submit()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? implicitHeight : 0
            visible: Collections.writableCollectionNames.length > 0
            spacing: Fluent.Enums.spacing.m

            Fluent.Label {
                type: Fluent.Enums.label.type_body_strong
                text: "加入歌单"
            }

            Fluent.ComboBox {
                id: targetCollection
                Layout.preferredWidth: 240
                model: Collections.writableCollectionNames
                currentIndex: Collections.targetIndex
                placeholderText: "选择目标歌单"
                onActivated: index => Collections.setTargetCollectionIndex(index)
            }

            Fluent.Label {
                Layout.fillWidth: true
                type: Fluent.Enums.label.type_caption
                text: "搜索结果右侧的添加按钮会写入这里"
                color: Fluent.Enums.tertiaryForeground
            }
        }

        Fluent.InfoBar {
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? implicitHeight : 0
            visible: Boolean(Collections.notice)
            title: "歌单已更新"
            message: Collections.notice
            severity: "success"
            closable: false
        }

        Fluent.InfoBar {
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? implicitHeight : 0
            visible: Boolean(Collections.error)
            title: "歌单操作失败"
            message: Collections.error
            severity: "error"
            closable: false
        }

        Fluent.ProgressBar {
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? implicitHeight : 0
            visible: Api.busy
            indeterminate: true
        }

        Fluent.InfoBar {
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? implicitHeight : 0
            visible: Boolean(Api.error)
            title: "搜索失败"
            message: Api.error
            severity: "error"
            closable: false
        }

        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            Fluent.ListWidget {
                id: resultList
                objectName: "searchResultList"
                anchors.fill: parent
                visible: Api.searchResults.length > 0
                model: Api.searchResults
                selectionMode: noSelection
                cardColor: Fluent.Enums.transparent
                borderVisible: true

                itemDelegate: Component {
                    SongRow {
                        song: modelData
                        queue: Api.searchResults
                        showAddButton: Collections.targetIndex >= 0
                        addEnabled: !Collections.busy
                        onPlayRequested: (song, queue) => Player.playSong(song, queue)
                        onAddRequested: song => Collections.addSong(song)
                    }
                }
            }

            Fluent.EmptyDataState {
                anchors.centerIn: parent
                visible: !Api.busy && Api.searchResults.length === 0
                image: Fluent.Enums.icon.music_note_2
                title: "输入关键词开始搜索"
            }
        }
    }
}
