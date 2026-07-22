// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent
import "../components"

Item {
    id: root

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
                    text: "正在播放"
                }

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_body
                    text: "原生播放控制与同步歌词"
                    color: Fluent.Enums.secondaryForeground
                }
            }

            Fluent.Tag {
                status: !Player.currentSong.id
                        ? Fluent.Enums.statusLevel.attention
                        : Player.playing
                        ? Fluent.Enums.statusLevel.success
                        : Fluent.Enums.statusLevel.info
                text: !Player.currentSong.id
                      ? "等待播放"
                      : Player.playing ? "播放中" : "已暂停"
            }
        }

        Fluent.SplitPane {
            objectName: "nowPlayingSplitPane"
            Layout.fillWidth: true
            Layout.fillHeight: true
            orientation: Qt.Horizontal
            splitPosition: 0.46
            minimumSize: 320

            firstContent: Item {
                anchors.fill: parent

                PlayerBar {
                    objectName: "playerPanel"
                    anchors.fill: parent
                    anchors.rightMargin: Fluent.Enums.spacing.m
                }
            }

            secondContent: Item {
                anchors.fill: parent

                Fluent.Card {
                    anchors.fill: parent
                    anchors.leftMargin: Fluent.Enums.spacing.m
                    cardType: Fluent.Enums.card.type_default

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: Fluent.Enums.spacing.xxl
                        spacing: Fluent.Enums.spacing.l

                        RowLayout {
                            Layout.fillWidth: true

                            Fluent.Label {
                                Layout.fillWidth: true
                                type: Fluent.Enums.label.type_subtitle
                                text: "歌词"
                            }

                            Fluent.Tag {
                                visible: Player.hasLyrics
                                status: Fluent.Enums.statusLevel.success
                                text: "已同步"
                            }
                        }

                        Item {
                            Layout.fillWidth: true
                            Layout.fillHeight: true

                            Fluent.ScrollArea {
                                id: lyricList
                                objectName: "lyricList"
                                anchors.fill: parent
                                visible: Player.hasLyrics
                                type: Fluent.Enums.scroll.type_list
                                model: Player.lyrics
                                itemHeight: 56
                                listSpacing: Fluent.Enums.spacing.xs
                                reuseItems: true
                                bounceEnabled: false
                                selectable: true
                                currentIndex: Player.currentLyricIndex

                                delegate: Item {
                                    required property var modelData
                                    required property int index

                                    width: ListView.view ? ListView.view.width : 0
                                    height: lyricList.itemHeight

                                    Fluent.Label {
                                        id: lyricText
                                        anchors.fill: parent
                                        anchors.leftMargin: Fluent.Enums.spacing.l
                                        anchors.rightMargin: Fluent.Enums.spacing.l
                                        type: index === Player.currentLyricIndex
                                              ? Fluent.Enums.label.type_body_strong
                                              : Fluent.Enums.label.type_body
                                        text: modelData.text || ""
                                        color: index === Player.currentLyricIndex
                                               ? Fluent.Enums.accentColor
                                               : Fluent.Enums.secondaryForeground
                                        horizontalAlignment: Text.AlignHCenter
                                        verticalAlignment: Text.AlignVCenter
                                        elide: Text.ElideRight
                                    }
                                }
                            }

                            Fluent.EmptyDataState {
                                anchors.centerIn: parent
                                visible: !Player.hasLyrics
                                image: Fluent.Enums.icon.music_note_off_2
                                title: Player.currentSong.id
                                       ? "这首歌暂时没有歌词"
                                       : "先从搜索页播放一首歌曲"
                            }
                        }
                    }
                }
            }
        }
    }

    Connections {
        target: Player

        function onCurrentLyricIndexChanged() {
            if (Player.currentLyricIndex >= 0
                    && lyricList.count > 0
                    && lyricList.flickableItem) {
                lyricList.flickableItem.positionViewAtIndex(
                    Player.currentLyricIndex,
                    ListView.Center
                )
            }
        }
    }
}
