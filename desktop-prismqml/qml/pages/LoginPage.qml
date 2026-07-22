// SPDX-License-Identifier: AGPL-3.0-only
import QtQuick
import QtQuick.Layouts
import PrismQML as Fluent

Item {
    id: root

    function submit() {
        Api.login(serviceInput.text, usernameInput.text, passwordInput.text)
    }

    RowLayout {
        anchors.fill: parent
        anchors.margins: Fluent.Enums.spacing.xxxl
        spacing: Fluent.Enums.spacing.xxxl

        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 4
            spacing: Fluent.Enums.spacing.l

            Item { Layout.fillHeight: true }

            Image {
                Layout.preferredWidth: 112
                Layout.preferredHeight: 112
                source: AppConfig.iconUrl
                fillMode: Image.PreserveAspectFit
            }

            Fluent.Label {
                Layout.fillWidth: true
                type: Fluent.Enums.label.type_title_large
                text: AppConfig.name
            }

            Fluent.Label {
                Layout.fillWidth: true
                Layout.maximumWidth: 420
                type: Fluent.Enums.label.type_subtitle
                text: "连接你的音乐服务"
                color: Fluent.Enums.secondaryForeground
            }

            Fluent.Tag {
                status: Fluent.Enums.statusLevel.attention
                text: "等待登录"
            }

            Fluent.Label {
                Layout.fillWidth: true
                Layout.maximumWidth: 420
                type: Fluent.Enums.label.type_body
                text: "这是独立桌面客户端。登录状态保存在本机，播放、歌词和桌面歌词均由原生 Qt 组件接管。"
                color: Fluent.Enums.secondaryForeground
                wrapMode: Text.WordWrap
            }

            Item { Layout.fillHeight: true }

            Fluent.Label {
                type: Fluent.Enums.label.type_caption
                text: "Melodex Desktop  " + AppConfig.version
                color: Fluent.Enums.tertiaryForeground
            }
        }

        Fluent.Card {
            Layout.fillWidth: true
            Layout.preferredWidth: 5
            Layout.maximumWidth: 520
            Layout.preferredHeight: 500
            Layout.alignment: Qt.AlignVCenter
            cardType: Fluent.Enums.card.type_elevated

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Fluent.Enums.spacing.xxxl
                spacing: Fluent.Enums.spacing.l

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_title
                    text: "登录"
                }

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_body
                    text: "填写 Melodex 地址和账户信息。"
                    color: Fluent.Enums.secondaryForeground
                }

                Fluent.LineEdit {
                    id: serviceInput
                    Layout.fillWidth: true
                    text: UserSettings.serviceUrl
                    placeholderText: "https://music.example.com"
                    label: "服务地址"
                    enabled: !Api.busy
                }

                Fluent.LineEdit {
                    id: usernameInput
                    Layout.fillWidth: true
                    placeholderText: "用户名"
                    label: "用户名"
                    enabled: !Api.busy
                    onAccepted: passwordInput.forceActiveFocus()
                }

                Fluent.LineEdit {
                    id: passwordInput
                    Layout.fillWidth: true
                    inputType: Fluent.Enums.input.type_password
                    placeholderText: "密码"
                    label: "密码"
                    enabled: !Api.busy
                    onAccepted: root.submit()
                }

                Fluent.InfoBar {
                    Layout.fillWidth: true
                    Layout.preferredHeight: implicitHeight
                    visible: Boolean(Api.error)
                    title: "连接失败"
                    message: Api.error
                    severity: "error"
                    closable: false
                }

                Item { Layout.fillHeight: true }

                Fluent.Button {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 44
                    text: "连接并登录"
                    icon: Fluent.Enums.icon.key
                    style: Fluent.Enums.button.style_primary
                    loading: Api.busy
                    loadingText: "正在连接"
                    enabled: !Api.busy
                    onClicked: root.submit()
                }

                Fluent.Label {
                    Layout.fillWidth: true
                    type: Fluent.Enums.label.type_caption
                    text: "若服务地址前存在仅浏览器可用的 SSO 网关，客户端会明确报告拦截，不会修改服务端配置。"
                    color: Fluent.Enums.tertiaryForeground
                    wrapMode: Text.WordWrap
                }
            }
        }
    }
}
