// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Fluent.Drawer {
    id: root

    readonly property int queueItemHeight: Fluent.Enums.controlSize.cardHeight
                                           + Fluent.Enums.spacing.s

    objectName: "playbackQueueDrawer"
    mode: Fluent.Enums.drawer.mode_outside
    position: Fluent.Enums.position.right

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Fluent.Enums.spacing.xxl
        spacing: Fluent.Enums.spacing.l

        RowLayout {
            Layout.fillWidth: true
            spacing: Fluent.Enums.spacing.m

            ColumnLayout {
                Layout.fillWidth: true
                spacing: Fluent.Enums.spacing.xxs

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_subtitle
                    text: "播放列表"
                }

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_caption
                    text: Player.queue.length > 0
                          ? "当前队列共 " + Player.queue.length + " 首"
                          : "当前没有待播放歌曲"
                    color: Fluent.Enums.secondaryForeground
                }
            }

            Fluent.Button {
                icon: Fluent.Enums.icon.dismiss
                shape: Fluent.Enums.button.shape_pill
                toolTipText: "关闭播放列表"
                onClicked: root.close()
            }
        }

        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            Fluent.ScrollArea {
                id: queueList
                objectName: "playbackQueueList"
                anchors.fill: parent
                visible: Player.queue.length > 0
                type: Fluent.Enums.scroll.type_list
                model: Player.queue
                itemHeight: root.queueItemHeight
                listSpacing: Fluent.Enums.spacing.xs
                reuseItems: true
                bounceEnabled: false
                selectable: true
                currentIndex: Player.queueIndex

                delegate: Item {
                    required property var modelData
                    required property int index

                    width: ListView.view ? ListView.view.width : 0
                    height: queueList.itemHeight

                    Fluent.Card {
                        anchors.fill: parent
                        anchors.margins: Fluent.Enums.spacing.xxs
                        cardType: Fluent.Enums.card.type_hover
                        contentPadding: Fluent.Enums.spacing.l
                        clickEnabled: true
                        onClicked: Player.playQueueIndex(index)

                        RowLayout {
                            anchors.fill: parent
                            spacing: Fluent.Enums.spacing.m

                            Fluent.ImageWidget {
                                Layout.preferredWidth: Fluent.Enums.controlSize.inputHeightLarge
                                Layout.preferredHeight: Fluent.Enums.controlSize.inputHeightLarge
                                radius: Fluent.Enums.radius.medium
                                source: Api.coverUrl(modelData)
                                fillMode: Image.PreserveAspectCrop
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: Fluent.Enums.spacing.xxs

                                Fluent.Label {
                                    Layout.fillWidth: true
                                    type: index === Player.queueIndex
                                          ? Fluent.Enums.label.type_body_strong
                                          : Fluent.Enums.label.type_body
                                    text: modelData.name || "未知歌曲"
                                    elide: Text.ElideRight
                                }

                                Fluent.Label {
                                    Layout.fillWidth: true
                                    type: Fluent.Enums.label.type_caption
                                    text: modelData.artist || "未知歌手"
                                    color: Fluent.Enums.secondaryForeground
                                    elide: Text.ElideRight
                                }
                            }

                            Fluent.Tag {
                                visible: index === Player.queueIndex
                                status: Player.playing
                                        ? Fluent.Enums.statusLevel.success
                                        : Fluent.Enums.statusLevel.info
                                text: Player.playing ? "播放中" : "当前"
                            }
                        }
                    }
                }
            }

            Fluent.EmptyDataState {
                anchors.centerIn: parent
                visible: Player.queue.length === 0
                image: Fluent.Enums.icon.music_note_off_2
                title: "播放歌曲后，队列会显示在这里"
            }
        }
    }

    Connections {
        target: Player

        function onQueueChanged() {
            if (Player.queueIndex >= 0
                    && queueList.count > 0
                    && queueList.flickableItem) {
                queueList.flickableItem.positionViewAtIndex(
                    Player.queueIndex,
                    ListView.Center
                )
            }
        }
    }

    Connections {
        target: Api

        function onAuthenticatedChanged() {
            if (!Api.authenticated)
                root.close()
        }
    }
}
