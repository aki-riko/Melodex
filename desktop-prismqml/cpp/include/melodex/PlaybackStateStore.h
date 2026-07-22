#pragma once

#include <QString>
#include <QVariantMap>
#include <optional>

namespace melodex {

class PlaybackStateStore final {
public:
    explicit PlaybackStateStore(QString path);

    std::optional<QVariantMap> load(const QString &serviceUrl,
                                    const QString &userId) const;
    bool save(const QString &serviceUrl, const QString &userId,
              const QVariantMap &state) const;

private:
    QString identityKey(const QString &serviceUrl, const QString &userId) const;
    QVariantMap readDocument() const;

    QString m_path;
};

}  // namespace melodex
