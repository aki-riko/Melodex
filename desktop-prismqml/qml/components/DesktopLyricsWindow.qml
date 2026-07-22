// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Window
import PrismQML as Fluent

Window {
    id: lyricsWindow

    readonly property int lineIndex: Player.currentLyricIndex
    readonly property var activeLine: lineIndex >= 0 && lineIndex < Player.lyrics.length
                                      ? Player.lyrics[lineIndex] : null
    readonly property var nextLine: lineIndex >= 0 && lineIndex + 1 < Player.lyrics.length
                                    ? Player.lyrics[lineIndex + 1] : null
    readonly property string activeText: activeLine
                                         ? activeLine.text
                                         : (Player.currentSong.name || "")
    readonly property string nextText: nextLine ? nextLine.text : ""

    width: 960
    height: 142
    x: Math.round((Screen.width - width) / 2)
    y: Math.round(Screen.height * 0.72)
    visible: UserSettings.lyricsVisible && Boolean(Player.currentSong.id)
    color: "transparent"
    title: "Melodex 桌面歌词"
    flags: Qt.FramelessWindowHint
           | Qt.WindowStaysOnTopHint
           | Qt.Tool
           | Qt.WindowDoesNotAcceptFocus
           | (UserSettings.clickThrough ? Qt.WindowTransparentForInput : 0)

    WordFill {
        id: activeLyric
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.leftMargin: Fluent.Enums.spacing.xxxl
        anchors.rightMargin: Fluent.Enums.spacing.xxxl
        height: 82
        text: lyricsWindow.activeText
        progress: lyricsWindow.activeLine ? Player.currentLyricProgress : 0
        pixelSize: Fluent.Enums.typography.giant
        minimumPixelSize: Fluent.Enums.typography.display
    }

    Text {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: activeLyric.bottom
        anchors.leftMargin: Fluent.Enums.spacing.xxxl
        anchors.rightMargin: Fluent.Enums.spacing.xxxl
        height: 48
        text: lyricsWindow.nextText
        color: Fluent.Enums.foregroundColor
        opacity: 0.78
        font.pixelSize: Fluent.Enums.typography.titleLarge
        font.bold: true
        fontSizeMode: Text.Fit
        minimumPixelSize: Fluent.Enums.typography.subtitle
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        style: Text.Outline
        styleColor: Qt.rgba(0, 0, 0, 0.68)
    }

    MouseArea {
        anchors.fill: parent
        enabled: !UserSettings.clickThrough
        acceptedButtons: Qt.LeftButton
        onPressed: lyricsWindow.startSystemMove()
        onDoubleClicked: UserSettings.setLyricsVisible(false)
    }
}
