// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import PrismQML as Fluent

Item {
    id: root

    property string text: ""
    property real progress: 0
    property int pixelSize: Fluent.Enums.typography.hero
    property int minimumPixelSize: Fluent.Enums.typography.titleLarge
    property string fontFamily: Fluent.Enums.fontFamily
    property bool bold: true
    property color restingColor: Fluent.Enums.secondaryForeground
    property color activeColor: Fluent.Enums.accentColor
    property real restingOpacity: 0.92
    property color outlineColor: Qt.rgba(0, 0, 0, 0.92)
    property color dropShadowColor: Qt.rgba(0, 0, 0, 0.72)
    property real dropShadowX: 2
    property real dropShadowY: 3
    readonly property real clampedProgress: Math.max(0, Math.min(1, progress))
    readonly property real textPaintedWidth: Math.min(width, baseLabel.paintedWidth)
    readonly property real textLeft: Math.max(0, (width - textPaintedWidth) / 2)

    Fluent.Label {
        id: shadowLabel
        x: root.dropShadowX
        y: root.dropShadowY
        width: root.width
        height: root.height
        type: Fluent.Enums.label.type_title_large
        text: root.text
        customTextColor: root.dropShadowColor
        font.family: root.fontFamily
        font.pixelSize: root.pixelSize
        font.weight: root.bold ? Font.DemiBold : Font.Medium
        font.letterSpacing: 0.6
        fontSizeMode: Text.Fit
        minimumPixelSize: root.minimumPixelSize
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        style: Text.Outline
        styleColor: root.outlineColor
    }

    Fluent.Label {
        id: baseLabel
        anchors.fill: parent
        type: Fluent.Enums.label.type_title_large
        text: root.text
        customTextColor: root.restingColor
        font.family: root.fontFamily
        font.pixelSize: root.pixelSize
        font.weight: root.bold ? Font.DemiBold : Font.Medium
        font.letterSpacing: 0.6
        fontSizeMode: Text.Fit
        minimumPixelSize: root.minimumPixelSize
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        opacity: root.restingOpacity
        style: Text.Outline
        styleColor: root.outlineColor
    }

    Item {
        x: root.textLeft
        width: root.textPaintedWidth * root.clampedProgress
        height: root.height
        clip: true

        Fluent.Label {
            x: -root.textLeft
            width: root.width
            height: root.height
            type: Fluent.Enums.label.type_title_large
            text: root.text
            customTextColor: root.activeColor
            font.family: root.fontFamily
            font.pixelSize: root.pixelSize
            font.weight: root.bold ? Font.DemiBold : Font.Medium
            font.letterSpacing: 0.6
            fontSizeMode: Text.Fit
            minimumPixelSize: root.minimumPixelSize
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            style: Text.Outline
            styleColor: root.outlineColor
        }
    }
}
