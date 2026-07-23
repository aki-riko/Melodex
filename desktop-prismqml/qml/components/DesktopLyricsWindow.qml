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
    readonly property int secondaryFontSize: Math.max(
                                                 16,
                                                 Math.round(UserSettings.lyricsFontSize * 0.67)
                                             )
    readonly property int activeLineHeight: UserSettings.lyricsFontSize + 20
    readonly property int secondaryLineHeight: secondaryFontSize + 14
    readonly property int lyricSurfaceWidth: Math.round(Math.min(
                                                            width - 24,
                                                            Math.max(
                                                                440,
                                                                Math.max(
                                                                    activeMetrics.advanceWidth,
                                                                    nextMetrics.advanceWidth
                                                                ) + 112
                                                            )
                                                        ))
    property bool positionReady: false

    width: Math.min(920, Math.max(640, Screen.width - 96))
    height: 46 + activeLineHeight + secondaryLineHeight + 18
    x: 0
    y: 0
    // DesktopState explicitly owns the native show/hide lifecycle. A declarative
    // visible binding left the Windows tool HWND uncreated after song changes.
    visible: false
    color: "transparent"
    title: "Melodex 桌面歌词"
    flags: Qt.FramelessWindowHint
           | Qt.WindowStaysOnTopHint
           | Qt.Tool
           | Qt.WindowDoesNotAcceptFocus
           | (UserSettings.clickThrough ? Qt.WindowTransparentForInput : 0)

    function defaultX() {
        return Screen.virtualX + Math.round((Screen.desktopAvailableWidth - width) / 2)
    }

    function defaultY() {
        return Screen.virtualY + Math.round(Screen.desktopAvailableHeight * 0.76)
    }

    function clampToVisibleArea() {
        const minimumX = Screen.virtualX
        const minimumY = Screen.virtualY
        const maximumX = minimumX + Math.max(0, Screen.desktopAvailableWidth - width)
        const maximumY = minimumY + Math.max(0, Screen.desktopAvailableHeight - height)
        x = Math.min(maximumX, Math.max(minimumX, x))
        y = Math.min(maximumY, Math.max(minimumY, y))
    }

    function restorePosition() {
        if (UserSettings.lyricsPositionSet) {
            x = UserSettings.lyricsX
            y = UserSettings.lyricsY
        } else {
            x = defaultX()
            y = defaultY()
        }
        Qt.callLater(function() {
            lyricsWindow.clampToVisibleArea()
            lyricsWindow.positionReady = true
        })
    }

    function schedulePositionSave() {
        if (positionReady && !UserSettings.clickThrough)
            positionSaveTimer.restart()
    }

    onXChanged: schedulePositionSave()
    onYChanged: schedulePositionSave()
    onHeightChanged: {
        if (positionReady)
            Qt.callLater(clampToVisibleArea)
    }

    Component.onCompleted: restorePosition()

    Timer {
        id: positionSaveTimer
        interval: 300
        repeat: false
        onTriggered: UserSettings.setLyricsPosition(
                         Math.round(lyricsWindow.x),
                         Math.round(lyricsWindow.y)
                     )
    }

    TextMetrics {
        id: activeMetrics
        font.family: UserSettings.lyricsFontFamily
        font.pixelSize: UserSettings.lyricsFontSize
        font.weight: Font.Medium
        text: lyricsWindow.activeText
    }

    TextMetrics {
        id: nextMetrics
        font.family: UserSettings.lyricsFontFamily
        font.pixelSize: lyricsWindow.secondaryFontSize
        font.weight: Font.Normal
        text: lyricsWindow.nextText
    }

    Connections {
        target: UserSettings

        function onLyricsPositionChanged() {
            if (UserSettings.lyricsPositionSet || !lyricsWindow.positionReady)
                return
            positionSaveTimer.stop()
            lyricsWindow.positionReady = false
            lyricsWindow.x = lyricsWindow.defaultX()
            lyricsWindow.y = lyricsWindow.defaultY()
            lyricsWindow.clampToVisibleArea()
            lyricsWindow.positionReady = true
        }
    }

    HoverHandler {
        id: windowHover
        enabled: !UserSettings.clickThrough
    }

    Item {
        id: lyricSurface
        z: 1
        anchors.top: parent.top
        anchors.topMargin: 32
        anchors.bottom: parent.bottom
        anchors.horizontalCenter: parent.horizontalCenter
        width: lyricsWindow.lyricSurfaceWidth
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
                toolTipText: "锁定桌面歌词（可从托盘或设置解锁）"
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
        z: 2
        anchors.left: lyricSurface.left
        anchors.right: lyricSurface.right
        anchors.top: lyricSurface.top
        anchors.topMargin: 12
        anchors.leftMargin: 34
        anchors.rightMargin: 34
        height: lyricsWindow.activeLineHeight
        text: lyricsWindow.activeText
        progress: lyricsWindow.activeLine ? Player.currentLyricProgress : 0
        fontFamily: UserSettings.lyricsFontFamily
        pixelSize: UserSettings.lyricsFontSize
        minimumPixelSize: UserSettings.lyricsFontSizeMinimum
        bold: false
        restingColor: UserSettings.lyricsUnplayedColor
        activeColor: UserSettings.lyricsPlayedColor
        restingOpacity: 0.92
        outlineColor: Qt.rgba(0, 0, 0, 0.92)
        dropShadowColor: Qt.rgba(0, 0, 0, 0.72)
    }

    Item {
        id: secondaryLyric
        z: 2
        anchors.left: lyricSurface.left
        anchors.right: lyricSurface.right
        anchors.top: activeLyric.bottom
        anchors.leftMargin: 42
        anchors.rightMargin: 42
        height: lyricsWindow.secondaryLineHeight

        Fluent.Label {
            x: 2
            y: 3
            width: parent.width
            height: parent.height
            type: Fluent.Enums.label.type_subtitle
            text: lyricsWindow.nextText
            customTextColor: Qt.rgba(0, 0, 0, 0.72)
            font.family: UserSettings.lyricsFontFamily
            font.pixelSize: lyricsWindow.secondaryFontSize
            font.weight: Font.Normal
            font.letterSpacing: 0.4
            fontSizeMode: Text.Fit
            minimumPixelSize: Math.max(14, UserSettings.lyricsFontSizeMinimum - 4)
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            style: Text.Outline
            styleColor: Qt.rgba(0, 0, 0, 0.92)
        }

        Fluent.Label {
            anchors.fill: parent
            type: Fluent.Enums.label.type_subtitle
            text: lyricsWindow.nextText
            customTextColor: UserSettings.lyricsUnplayedColor
            opacity: 0.66
            font.family: UserSettings.lyricsFontFamily
            font.pixelSize: lyricsWindow.secondaryFontSize
            font.weight: Font.Normal
            font.letterSpacing: 0.4
            fontSizeMode: Text.Fit
            minimumPixelSize: Math.max(14, UserSettings.lyricsFontSizeMinimum - 4)
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            style: Text.Outline
            styleColor: Qt.rgba(0, 0, 0, 0.92)
        }
    }

    Fluent.WindowDragHandle {
        z: 9
        anchors.fill: parent
        enabled: !UserSettings.clickThrough
        acceptedButtons: Qt.LeftButton
        onDoubleClicked: UserSettings.setLyricsVisible(false)
    }
}
