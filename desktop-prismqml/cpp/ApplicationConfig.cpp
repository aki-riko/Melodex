#include "melodex/ApplicationConfig.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <stdexcept>

namespace melodex {

ApplicationConfig loadApplicationConfig(const QString &resourcePath) {
    QFile file(resourcePath);
    if (!file.open(QIODevice::ReadOnly))
        throw std::runtime_error("无法读取桌面客户端 app_config.json");

    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject())
        throw std::runtime_error("桌面客户端 app_config.json 格式无效");

    const QJsonObject root = document.object();
    const QJsonObject window = root.value(QStringLiteral("window")).toObject();
    ApplicationConfig result;
    result.applicationName = root.value(QStringLiteral("application_name")).toString();
    result.applicationVersion = root.value(QStringLiteral("application_version")).toString();
    result.applicationId = root.value(QStringLiteral("application_id")).toString();
    result.accentColor = root.value(QStringLiteral("accent_color")).toString();
    result.window.width = window.value(QStringLiteral("width")).toInt(result.window.width);
    result.window.height = window.value(QStringLiteral("height")).toInt(result.window.height);
    result.window.minimumWidth = window.value(QStringLiteral("minimum_width")).toInt(
        result.window.minimumWidth);
    result.window.minimumHeight = window.value(QStringLiteral("minimum_height")).toInt(
        result.window.minimumHeight);
    if (result.applicationName.isEmpty() || result.applicationId.isEmpty())
        throw std::runtime_error("桌面客户端 app_config.json 缺少应用标识");
    return result;
}

}  // namespace melodex
