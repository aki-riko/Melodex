// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent
import "../components"

Item {
    id: root

    signal openPlayerRequested()

    readonly property var collectionItems: {
        var result = []
        for (var index = 0; index < Collections.collections.length; ++index) {
            var collection = Collections.collections[index]
            result.push({
                text: collection.name,
                icon: collection.kind === "favorite"
                      ? Fluent.Enums.icon.heart
                      : (collection.kind === "imported"
                         ? Fluent.Enums.icon.cloud
                         : Fluent.Enums.icon.collections)
            })
        }
        return result
    }
    readonly property string playlistCoverSource: {
        var selected = Collections.selectedCollection || ({})
        if (selected.cover) return Api.coverUrl(selected)
        if (Collections.songs.length > 0) return Api.coverUrl(Collections.songs[0])
        return ""
    }

    function createPlaylist() {
        var name = newPlaylistName.text.trim()
        if (name.length > 0) {
            Collections.createCollection(name)
        }
    }

    function playAll() {
        if (Collections.songs.length === 0) return
        Player.playSong(Collections.songs[0], Collections.songs)
        root.openPlayerRequested()
    }

    Fluent.SplitPane {
        anchors.fill: parent
        orientation: Qt.Horizontal
        splitPosition: 0.34
        minimumSize: 280

        firstContent: Item {
            anchors.fill: parent

            Fluent.Card {
                anchors.fill: parent
                anchors.margins: Fluent.Enums.spacing.xxxl
                anchors.rightMargin: Fluent.Enums.spacing.m
                contentPadding: Fluent.Enums.spacing.xl

                Item {
                    anchors.fill: parent

                    RowLayout {
                        id: collectionHeader
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: parent.top
                        height: implicitHeight

                        Fluent.Label {
                            Layout.fillWidth: true
                            type: Fluent.Enums.label.type_title
                            text: "我的歌单"
                        }

                        Fluent.Button {
                            icon: Fluent.Enums.icon.arrow_sync
                            shape: Fluent.Enums.button.shape_pill
                            toolTipText: "刷新歌单"
                            loading: Collections.busy
                            onClicked: Collections.refresh()
                        }
                    }

                    RowLayout {
                        id: collectionCreator
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: collectionHeader.bottom
                        anchors.topMargin: Fluent.Enums.spacing.l
                        height: implicitHeight
                        spacing: Fluent.Enums.spacing.s

                        Fluent.LineEdit {
                            id: newPlaylistName
                            Layout.fillWidth: true
                            placeholderText: "新建歌单"
                            onAccepted: root.createPlaylist()
                        }

                        Fluent.Button {
                            icon: Fluent.Enums.icon.add
                            style: Fluent.Enums.button.style_primary
                            shape: Fluent.Enums.button.shape_pill
                            toolTipText: "创建歌单"
                            enabled: !Collections.busy
                                     && newPlaylistName.text.trim().length > 0
                            onClicked: root.createPlaylist()
                        }
                    }

                    Fluent.ListWidget {
                        id: collectionList
                        objectName: "collectionList"
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: collectionCreator.bottom
                        anchors.bottom: collectionFooter.top
                        anchors.topMargin: Fluent.Enums.spacing.l
                        anchors.bottomMargin: Fluent.Enums.spacing.l
                        model: root.collectionItems
                        currentIndex: Collections.selectedIndex
                        selectionMode: singleSelection
                        cardColor: Fluent.Enums.transparent
                        borderVisible: true
                        onItemClicked: (index, _item) =>
                                           Collections.selectCollectionIndex(index)
                    }

                    Fluent.Label {
                        id: collectionFooter
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        visible: Collections.collections.length > 0
                        type: Fluent.Enums.label.type_caption
                        text: Collections.collections.length + " 个歌单"
                        color: Fluent.Enums.tertiaryForeground
                        horizontalAlignment: Text.AlignHCenter
                    }
                }
            }
        }

        secondContent: Item {
            anchors.fill: parent

            Fluent.Card {
                anchors.fill: parent
                anchors.margins: Fluent.Enums.spacing.xxxl
                anchors.leftMargin: Fluent.Enums.spacing.m
                contentPadding: Fluent.Enums.spacing.xl

                Item {
                    anchors.fill: parent

                    RowLayout {
                        id: playlistHeader
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: parent.top
                        height: Math.max(64, implicitHeight)
                        spacing: Fluent.Enums.spacing.l

                        Fluent.ImageWidget {
                            Layout.preferredWidth: 64
                            Layout.preferredHeight: 64
                            visible: Boolean(Collections.selectedCollection.id)
                            radius: Fluent.Enums.radius.large
                            source: root.playlistCoverSource
                            fillMode: Image.PreserveAspectCrop
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: Fluent.Enums.spacing.xs

                            Fluent.Label {
                                Layout.fillWidth: true
                                type: Fluent.Enums.label.type_title
                                text: Collections.selectedCollection.name || "选择一个歌单"
                                elide: Text.ElideRight
                            }

                            Fluent.Label {
                                Layout.fillWidth: true
                                visible: Boolean(Collections.selectedCollection.id)
                                type: Fluent.Enums.label.type_body
                                text: Collections.selectedCollection.description
                                      || Collections.selectedCollection.creator
                                      || "Melodex 个人歌单"
                                color: Fluent.Enums.secondaryForeground
                                elide: Text.ElideRight
                            }
                        }

                        Fluent.Tag {
                            visible: Boolean(Collections.selectedCollection.id)
                            status: Collections.selectedCollection.kind === "favorite"
                                    ? Fluent.Enums.statusLevel.success
                                    : Fluent.Enums.statusLevel.info
                            text: Collections.selectedCollection.kind === "favorite"
                                  ? "我喜欢"
                                  : (Collections.selectedCollection.kind === "imported"
                                     ? String(Collections.selectedCollection.source).toUpperCase()
                                     : "自建")
                            showDot: false
                        }

                        Fluent.Button {
                            visible: Collections.songs.length > 0
                            text: "播放全部"
                            icon: Fluent.Enums.icon.play
                            style: Fluent.Enums.button.style_primary
                            onClicked: root.playAll()
                        }

                        Fluent.Button {
                            visible: Boolean(Collections.selectedCollection.id)
                            icon: Fluent.Enums.icon.arrow_sync
                            shape: Fluent.Enums.button.shape_pill
                            toolTipText: "刷新曲目"
                            loading: Collections.busy
                            onClicked: Collections.refreshSongs()
                        }
                    }

                    ColumnLayout {
                        id: feedbackStack
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: playlistHeader.bottom
                        anchors.topMargin: Fluent.Enums.spacing.l
                        height: implicitHeight
                        spacing: Fluent.Enums.spacing.s

                        Fluent.InfoBar {
                            Layout.fillWidth: true
                            Layout.preferredHeight: visible ? implicitHeight : 0
                            visible: Boolean(Collections.error)
                            title: "歌单加载失败"
                            message: Collections.error
                            severity: "error"
                            closable: false
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

                        Fluent.ProgressBar {
                            Layout.fillWidth: true
                            Layout.preferredHeight: visible ? implicitHeight : 0
                            visible: Collections.busy
                            indeterminate: true
                        }
                    }

                    Item {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: feedbackStack.bottom
                        anchors.bottom: parent.bottom
                        anchors.topMargin: Fluent.Enums.spacing.l

                        Fluent.ListWidget {
                            id: songList
                            objectName: "playlistSongList"
                            anchors.fill: parent
                            visible: Collections.songs.length > 0
                            model: Collections.songs
                            selectionMode: noSelection
                            cardColor: Fluent.Enums.transparent
                            borderVisible: true

                            itemDelegate: Component {
                                SongRow {
                                    song: modelData
                                    queue: Collections.songs
                                    onPlayRequested: (song, queue) => {
                                        Player.playSong(song, queue)
                                        root.openPlayerRequested()
                                    }
                                }
                            }
                        }

                        Fluent.EmptyDataState {
                            anchors.centerIn: parent
                            visible: !Collections.busy
                                     && Collections.songs.length === 0
                            image: Collections.selectedCollection.id
                                   ? Fluent.Enums.icon.music_note_2
                                   : Fluent.Enums.icon.collections
                            title: Collections.selectedCollection.id
                                   ? "这个歌单还没有歌曲"
                                   : "还没有可显示的歌单"
                        }
                    }
                }
            }
        }
    }

    Connections {
        target: Collections

        function onCollectionCreated(_collectionId) {
            newPlaylistName.clear()
        }
    }
}
