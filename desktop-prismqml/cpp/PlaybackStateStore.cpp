#include "melodex/PlaybackStateStore.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>

namespace melodex {
namespace {

QVariantMap emptyDocument() {
    return {{QStringLiteral("version"), 1},
            {QStringLiteral("accounts"), QVariantMap{}}};
}

}  // namespace

PlaybackStateStore::PlaybackStateStore(QString path) : m_path(std::move(path)) {}

QString PlaybackStateStore::identityKey(const QString &serviceUrl,
                                         const QString &userId) const {
    QByteArray identity = serviceUrl.trimmed().toUtf8();
    identity.append('\0');
    identity.append(userId.trimmed().toUtf8());
    return QString::fromLatin1(
        QCryptographicHash::hash(identity, QCryptographicHash::Sha256).toHex());
}

QVariantMap PlaybackStateStore::readDocument() const {
    QFile file(m_path);
    if (!file.exists() || !file.open(QIODevice::ReadOnly))
        return emptyDocument();
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    const QVariantMap root = document.toVariant().toMap();
    if (parseError.error != QJsonParseError::NoError ||
        root.value(QStringLiteral("version")).toInt() != 1 ||
        !root.value(QStringLiteral("accounts")).canConvert<QVariantMap>()) {
        qWarning() << "[WARN] 桌面播放状态格式无效，将忽略旧数据";
        return emptyDocument();
    }
    return root;
}

std::optional<QVariantMap> PlaybackStateStore::load(const QString &serviceUrl,
                                                    const QString &userId) const {
    const QVariantMap accounts = readDocument().value(QStringLiteral("accounts")).toMap();
    const QVariantMap entry = accounts.value(identityKey(serviceUrl, userId)).toMap();
    if (entry.isEmpty())
        return std::nullopt;
    if (entry.value(QStringLiteral("service_url")).toString() != serviceUrl ||
        entry.value(QStringLiteral("user_id")).toString() != userId ||
        !entry.value(QStringLiteral("state")).canConvert<QVariantMap>()) {
        qWarning() << "[WARN] 忽略身份不匹配的播放状态";
        return std::nullopt;
    }
    return entry.value(QStringLiteral("state")).toMap();
}

bool PlaybackStateStore::save(const QString &serviceUrl, const QString &userId,
                              const QVariantMap &state) const {
    QVariantMap root = readDocument();
    QVariantMap accounts = root.value(QStringLiteral("accounts")).toMap();
    accounts.insert(identityKey(serviceUrl, userId),
                    QVariantMap{{QStringLiteral("service_url"), serviceUrl},
                                {QStringLiteral("user_id"), userId},
                                {QStringLiteral("updated_at"),
                                 QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)},
                                {QStringLiteral("state"), state}});
    root.insert(QStringLiteral("accounts"), accounts);
    const QFileInfo info(m_path);
    if (!QDir().mkpath(info.absolutePath()))
        return false;
    QSaveFile file(m_path);
    file.setDirectWriteFallback(false);
    const QByteArray body = QJsonDocument::fromVariant(root).toJson(QJsonDocument::Indented);
    const bool ok = file.open(QIODevice::WriteOnly) && file.write(body) == body.size() &&
                    file.commit();
    if (!ok)
        qWarning().noquote() << "[WARN] 保存桌面播放状态失败：" << file.errorString();
#ifndef Q_OS_WIN
    if (ok)
        QFile::setPermissions(m_path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
#endif
    return ok;
}

}  // namespace melodex
