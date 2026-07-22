// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Window
import PrismQML as Fluent

Window {
    id: lyricsWindow
    objectName: "desktopLyricsWindow"

    readonly property int lineIndex: Player.currentLyricIndex
    readonly property var activeLine: lineIndex >= 0 && lineIndex < Player.lyrics.length
                                      ? Player.lyrics[lineIndex] : null
    readonly property var nextLine: lineIndex >= 0 && lineIndex + 1 < Player.lyrics.length
                                    ? Player.lyrics[lineIndex + 1]
                                    : (lineIndex < 0 && Player.lyrics.length > 0
                                       ? Player.lyrics[0] : null)
    readonly property string activeText: activeLine
                                         ? activeLine.text
                                         : (Player.currentSong.name || "")
    readonly property string nextText: nextLine
                                       ? nextLine.text
                                       : (Player.currentSong.artist || "")
    readonly property bool controlsVisible: !UserSettings.clickThrough
                                            && windowHover.hovered

    width: Math.min(920, Math.max(640, Screen.width - 96))
    height: 116
    x: Math.round((Screen.width - width) / 2)
    y: Math.round(Screen.height * 0.76)
    // Python explicitly owns the native show/hide lifecycle. A declarative
    // visible binding left the Windows tool HWND uncreated after song changes.
    visible: false
    color: "transparent"
    title: "Melodex 桌面歌词"
    flags: Qt.FramelessWindowHint
           | Qt.WindowStaysOnTopHint
           | Qt.Tool
           | Qt.WindowDoesNotAcceptFocus
           | (UserSettings.clickThrough ? Qt.WindowTransparentForInput : 0)

    HoverHandler {
        id: windowHover
        enabled: !UserSettings.clickThrough
    }

    Fluent.Card {
        id: controlBar
        z: 10
        anchors.top: parent.top
        anchors.horizontalCenter: parent.horizontalCenter
        width: 212
        height: 38
        borderRadius: height / 2
        interactionEnabled: false
        color: Qt.rgba(0.97, 0.98, 0.99, 0.94)
        border.width: Fluent.Enums.border.thin
        border.color: Qt.rgba(0.12, 0.14, 0.16, 0.20)
        opacity: lyricsWindow.controlsVisible ? 1 : 0
        visible: opacity > 0.01
        scale: lyricsWindow.controlsVisible ? 1 : 0.96

        Behavior on opacity {
            NumberAnimation { duration: Fluent.Enums.duration.fast }
        }

        Behavior on scale {
            NumberAnimation {
                duration: Fluent.Enums.duration.fast
                easing.type: Easing.OutCubic
            }
        }

        Row {
            anchors.centerIn: parent
            spacing: Fluent.Enums.spacing.xs

            Fluent.Button {
                width: 32
                height: 30
                style: Fluent.Enums.button.style_transparent
                icon: Fluent.Enums.icon.previous
                iconSize: Fluent.Enums.iconSize.s
                toolTipText: "上一首"
                onClicked: Player.previous()
            }

            Fluent.Button {
                width: 32
                height: 30
                style: Fluent.Enums.button.style_primary
                shape: Fluent.Enums.button.shape_pill
                icon: Player.playing ? Fluent.Enums.icon.pause : Fluent.Enums.icon.play
                iconSize: Fluent.Enums.iconSize.s
                toolTipText: Player.playing ? "暂停" : "播放"
                onClicked: Player.togglePlay()
            }

            Fluent.Button {
                width: 32
                height: 30
                style: Fluent.Enums.button.style_transparent
                icon: Fluent.Enums.icon.next
                iconSize: Fluent.Enums.iconSize.s
                toolTipText: "下一首"
                onClicked: Player.next()
            }

            Fluent.Button {
                width: 32
                height: 30
                style: Fluent.Enums.button.style_transparent
                icon: Fluent.Enums.icon.desktop_cursor
                iconSize: Fluent.Enums.iconSize.s
                toolTipText: "锁定并开启鼠标穿透"
                onClicked: UserSettings.setClickThrough(true)
            }

            Fluent.Button {
                width: 32
                height: 30
                style: Fluent.Enums.button.style_transparent
                icon: Fluent.Enums.icon.dismiss
                iconSize: Fluent.Enums.iconSize.s
                toolTipText: "关闭桌面歌词"
                onClicked: UserSettings.setLyricsVisible(false)
            }
        }
    }

    WordFill {
        id: activeLyric
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.topMargin: 36
        anchors.leftMargin: Fluent.Enums.spacing.xxl
        anchors.rightMargin: Fluent.Enums.spacing.xxl
        height: 46
        text: lyricsWindow.activeText
        progress: lyricsWindow.activeLine ? Player.currentLyricProgress : 0
        pixelSize: Fluent.Enums.typography.hero
        minimumPixelSize: Fluent.Enums.typography.titleLarge
        restingColor: "#FFF4F7F5"
        activeColor: Fluent.Enums.accentColor
        outlineColor: Qt.rgba(0, 0, 0, 0.82)
    }

    Fluent.Label {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: activeLyric.bottom
        anchors.leftMargin: Fluent.Enums.spacing.xxl
        anchors.rightMargin: Fluent.Enums.spacing.xxl
        height: 32
        type: Fluent.Enums.label.type_subtitle
        text: lyricsWindow.nextText
        customTextColor: "#EAF1F3F1"
        opacity: 0.86
        font.pixelSize: Fluent.Enums.typography.display
        font.weight: Font.DemiBold
        fontSizeMode: Text.Fit
        minimumPixelSize: Fluent.Enums.typography.subtitle
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        style: Text.Outline
        styleColor: Qt.rgba(0, 0, 0, 0.78)
    }

    Fluent.WindowDragHandle {
        anchors.fill: parent
        enabled: !UserSettings.clickThrough
        acceptedButtons: Qt.LeftButton
        onDoubleClicked: UserSettings.setLyricsVisible(false)
    }
}
