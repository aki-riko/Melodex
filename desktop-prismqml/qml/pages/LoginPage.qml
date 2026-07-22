// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Item {
    id: root

    function submit() {
        Api.login(serviceInput.text, usernameInput.text, passwordInput.text)
    }

    Rectangle {
        anchors.fill: parent
        color: Fluent.Enums.backgroundColor

        Fluent.Card {
            anchors.centerIn: parent
            width: Math.min(520, parent.width - Fluent.Enums.spacing.xxxl * 2)
            height: 510
            cardType: Fluent.Enums.card.type_elevated

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Fluent.Enums.spacing.xxxl
                spacing: Fluent.Enums.spacing.l

                Image {
                    Layout.alignment: Qt.AlignHCenter
                    Layout.preferredWidth: 84
                    Layout.preferredHeight: 84
                    source: AppConfig.iconUrl
                    fillMode: Image.PreserveAspectFit
                }

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "连接 Melodex"
                    color: Fluent.Enums.foregroundColor
                    font.pixelSize: Fluent.Enums.typography.displayLarge
                    font.bold: true
                }

                Text {
                    Layout.fillWidth: true
                    text: "使用你自己的 Melodex 服务，登录后会自动保持会话。"
                    color: Fluent.Enums.secondaryForeground
                    font.pixelSize: Fluent.Enums.typography.body
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                }

                Fluent.LineEdit {
                    id: serviceInput
                    Layout.fillWidth: true
                    Layout.preferredHeight: 42
                    text: UserSettings.serviceUrl
                    placeholderText: "https://你的-melodex-地址"
                    label: "服务地址"
                }

                Fluent.LineEdit {
                    id: usernameInput
                    Layout.fillWidth: true
                    Layout.preferredHeight: 42
                    placeholderText: "用户名"
                    label: "用户名"
                }

                Fluent.LineEdit {
                    id: passwordInput
                    Layout.fillWidth: true
                    Layout.preferredHeight: 42
                    inputType: Fluent.Enums.input.type_password
                    placeholderText: "密码"
                    label: "密码"
                    onAccepted: root.submit()
                }

                Text {
                    Layout.fillWidth: true
                    visible: Boolean(Api.error)
                    text: Api.error
                    color: Fluent.Enums.infoAccentColor
                    font.pixelSize: Fluent.Enums.typography.caption
                    wrapMode: Text.WordWrap
                }

                Fluent.Button {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 44
                    text: "登录"
                    icon: Fluent.Enums.icon.key
                    style: Fluent.Enums.button.style_primary
                    loading: Api.busy
                    loadingText: "正在连接"
                    enabled: !Api.busy
                    onClicked: root.submit()
                }

                Text {
                    Layout.fillWidth: true
                    text: "如果地址前还有 Authentik 等网页登录网关，客户端会明确提示被拦截；此客户端不会改动服务端代理配置。"
                    color: Fluent.Enums.tertiaryForeground
                    font.pixelSize: Fluent.Enums.typography.captionCompact
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignHCenter
                }
            }
        }
    }
}
