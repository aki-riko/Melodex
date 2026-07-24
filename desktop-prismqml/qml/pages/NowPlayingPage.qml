// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent
import "../components"

Item {
    id: root

    signal queueRequested()

    property real lyricDisplayPosition: Player.position
    readonly property int displayLyricIndex:
        Player.visualLyricIndex(lyricDisplayPosition)
    readonly property real displayLyricProgress:
        displayLyricIndex >= 0
        ? Player.visualLyricProgress(displayLyricIndex, lyricDisplayPosition)
        : 0

    onDisplayLyricIndexChanged: Qt.callLater(root.centerCurrentLyric)
    onVisibleChanged: {
        if (visible)
            lyricDisplayPosition = Player.visualPosition()
    }

    function centerCurrentLyric() {
        if (displayLyricIndex < 0
                || lyricList.count <= 0
                || !lyricList.flickableItem) {
            return
        }

        const itemExtent = lyricList.itemHeight + lyricList.listSpacing
        const originY = lyricList.flickableItem.originY
        const centeredY = originY
                + displayLyricIndex * itemExtent
                - (lyricList.height - lyricList.itemHeight) / 2
        lyricList.smoothScrollTo(centeredY)
    }

    FrameAnimation {
        id: lyricProgressFrame
        running: root.visible && Player.playing && Player.hasLyrics
        onTriggered: root.lyricDisplayPosition = Player.visualPosition()
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
                    text: "正在播放"
                }

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_body
                    text: "原生播放控制与同步歌词"
                    color: Fluent.Enums.secondaryForeground
                }
            }

            Fluent.Button {
                text: "播放列表（" + Player.queue.length + "）"
                icon: Fluent.Enums.icon.collections
                enabled: Player.queue.length > 0
                onClicked: root.queueRequested()
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
                            spacing: Fluent.Enums.spacing.m

                            Fluent.Icon {
                                icon: Fluent.Enums.icon.music_note_2_play
                                iconSize: Fluent.Enums.iconSize.l
                                color: Fluent.Enums.accentColor
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: Fluent.Enums.spacing.xxs

                                Fluent.Label {
                                    Layout.fillWidth: true
                                    type: Fluent.Enums.label.type_subtitle
                                    text: "同步歌词"
                                }

                                Fluent.Label {
                                    Layout.fillWidth: true
                                    type: Fluent.Enums.label.type_body_small
                                    text: Player.currentSong.id
                                          ? (Player.currentSong.name || "未知歌曲")
                                            + "  ·  "
                                            + (Player.currentSong.artist || "未知歌手")
                                          : "播放歌曲后，歌词会自动跟随进度"
                                    color: Fluent.Enums.secondaryForeground
                                    elide: Text.ElideRight
                                }
                            }

                            Fluent.Tag {
                                visible: Player.hasLyrics
                                status: Player.playing
                                        ? Fluent.Enums.statusLevel.success
                                        : Fluent.Enums.statusLevel.info
                                text: Player.playing ? "自动跟随" : "已暂停"
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
                                itemHeight: 76
                                listSpacing: Fluent.Enums.spacing.s
                                reuseItems: true
                                bounceEnabled: false
                                selectable: false
                                currentIndex: -1
                                scrollDuration: Fluent.Enums.duration.slower
                                scrollEasing: Easing.OutCubic
                                onHeightChanged: Qt.callLater(root.centerCurrentLyric)

                                delegate: Item {
                                    required property var modelData
                                    required property int index
                                    readonly property bool isCurrentLine:
                                        index === root.displayLyricIndex
                                    readonly property int distanceFromCurrent:
                                        root.displayLyricIndex < 0
                                        ? 0
                                        : Math.abs(index - root.displayLyricIndex)

                                    width: ListView.view ? ListView.view.width : 0
                                    height: lyricList.itemHeight
                                    opacity: isCurrentLine
                                             ? 1
                                             : distanceFromCurrent <= 1
                                               ? 0.72
                                               : distanceFromCurrent === 2
                                                 ? 0.52
                                                 : 0.34
                                    scale: isCurrentLine
                                           ? 1
                                           : distanceFromCurrent <= 1 ? 0.96 : 0.92

                                    WordFill {
                                        visible: parent.isCurrentLine
                                        anchors.fill: parent
                                        anchors.leftMargin: Fluent.Enums.spacing.xxl
                                        anchors.rightMargin: Fluent.Enums.spacing.xxl
                                        text: modelData.text || ""
                                        progress: parent.isCurrentLine
                                                  ? root.displayLyricProgress : 0
                                        pixelSize: Fluent.Enums.typography.displayLarge
                                        minimumPixelSize: Fluent.Enums.typography.titleLarge
                                        fontFamily: Fluent.Enums.fontFamily
                                        bold: true
                                        restingColor: Fluent.Enums.secondaryForeground
                                        activeColor: Fluent.Enums.accentColor
                                        restingOpacity: 1
                                        outlineColor: Fluent.Enums.transparent
                                        shadowColor: Fluent.Enums.transparent
                                        shadowBlur: 0
                                        shadowVerticalOffset: 0
                                    }

                                    Fluent.Label {
                                        visible: !parent.isCurrentLine
                                        anchors.fill: parent
                                        anchors.leftMargin: Fluent.Enums.spacing.xxl
                                        anchors.rightMargin: Fluent.Enums.spacing.xxl
                                        type: Fluent.Enums.label.type_subtitle
                                        text: modelData.text || ""
                                        color: Fluent.Enums.secondaryForeground
                                        horizontalAlignment: Text.AlignHCenter
                                        verticalAlignment: Text.AlignVCenter
                                        elide: Text.ElideRight
                                    }

                                    Behavior on opacity {
                                        NumberAnimation {
                                            duration: Fluent.Enums.duration.normal
                                        }
                                    }

                                    Behavior on scale {
                                        NumberAnimation {
                                            duration: Fluent.Enums.duration.normal
                                            easing.type: Easing.OutCubic
                                        }
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

        function onPositionChanged() {
            if (!Player.playing)
                root.lyricDisplayPosition = Player.position
        }

        function onPlayingChanged() {
            root.lyricDisplayPosition = Player.visualPosition()
        }

        function onCurrentSongChanged() {
            root.lyricDisplayPosition = Player.position
        }

        function onLyricsChanged() {
            root.lyricDisplayPosition = Player.position
            Qt.callLater(root.centerCurrentLyric)
        }
    }
}
