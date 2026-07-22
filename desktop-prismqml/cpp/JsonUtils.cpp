#include "melodex/JsonUtils.h"

#include <QJsonDocument>
#include <QJsonObject>

namespace melodex {
namespace {

QString firstString(const QVariantMap &value, const QString &primary,
                    const QString &legacy = {}) {
    QVariant raw = value.value(primary);
    if ((!raw.isValid() || raw.toString().isEmpty()) && !legacy.isEmpty())
        raw = value.value(legacy);
    return raw.toString().trimmed();
}

double safeDuration(const QVariant &value) {
    bool ok = false;
    const double duration = value.toDouble(&ok);
    return ok && duration >= 0.0 ? duration : 0.0;
}

}  // namespace

QVariantMap normalizeSong(const QVariantMap &value) {
    QVariantMap result = value;
    result.insert(QStringLiteral("id"), firstString(value, QStringLiteral("id"),
                                                     QStringLiteral("ID")));
    result.insert(QStringLiteral("source"), firstString(value, QStringLiteral("source"),
                                                         QStringLiteral("Source")).toLower());
    result.insert(QStringLiteral("name"), firstString(value, QStringLiteral("name"),
                                                       QStringLiteral("Name")));
    result.insert(QStringLiteral("artist"), firstString(value, QStringLiteral("artist"),
                                                         QStringLiteral("Artist")));
    QString album = firstString(value, QStringLiteral("album"), QStringLiteral("Album"));
    const QVariantMap extra = value.value(QStringLiteral("extra")).toMap();
    if (album.isEmpty())
        album = extra.value(QStringLiteral("album")).toString().trimmed();
    result.insert(QStringLiteral("album"), album);
    result.insert(QStringLiteral("cover"), firstString(value, QStringLiteral("cover"),
                                                        QStringLiteral("Cover")));
    QVariant duration = value.value(QStringLiteral("duration"));
    if (!duration.isValid())
        duration = value.value(QStringLiteral("Duration"));
    result.insert(QStringLiteral("duration"), safeDuration(duration));
    result.insert(QStringLiteral("extra"), extra);
    return result;
}

QVariantMap normalizeCollection(const QVariantMap &value) {
    QVariantMap result = value;
    result.insert(QStringLiteral("id"), value.value(QStringLiteral("id")).toString());
    const QString rawName = value.value(QStringLiteral("name")).toString().trimmed();
    result.insert(QStringLiteral("name"), rawName.isEmpty() ? QStringLiteral("未命名歌单")
                                                            : rawName);
    result.insert(QStringLiteral("description"),
                  value.value(QStringLiteral("description")).toString().trimmed());
    result.insert(QStringLiteral("cover"),
                  value.value(QStringLiteral("cover")).toString().trimmed());
    QString kind = value.value(QStringLiteral("kind")).toString().trimmed().toLower();
    result.insert(QStringLiteral("kind"), kind.isEmpty() ? QStringLiteral("manual") : kind);
    QString contentType = value.value(QStringLiteral("content_type")).toString()
                              .trimmed().toLower();
    result.insert(QStringLiteral("content_type"),
                  contentType.isEmpty() ? QStringLiteral("playlist") : contentType);
    QString source = value.value(QStringLiteral("source")).toString().trimmed().toLower();
    result.insert(QStringLiteral("source"),
                  source.isEmpty() ? QStringLiteral("local") : source);
    result.insert(QStringLiteral("creator"),
                  value.value(QStringLiteral("creator")).toString().trimmed());
    result.insert(QStringLiteral("track_count"),
                  value.value(QStringLiteral("track_count")).toInt());
    return result;
}

QVariantMap songWritePayload(const QVariantMap &value) {
    const QVariantMap song = normalizeSong(value);
    QVariantMap payload;
    for (const QString &key : {QStringLiteral("id"), QStringLiteral("source"),
                               QStringLiteral("name"), QStringLiteral("artist"),
                               QStringLiteral("album"), QStringLiteral("cover"),
                               QStringLiteral("extra")})
        payload.insert(key, song.value(key));
    QString albumId = value.value(QStringLiteral("album_id")).toString();
    if (albumId.isEmpty())
        albumId = value.value(QStringLiteral("albumId")).toString();
    payload.insert(QStringLiteral("album_id"), albumId);
    payload.insert(QStringLiteral("duration"),
                   qMax(0, static_cast<int>(song.value(QStringLiteral("duration")).toDouble())));
    return payload;
}

QUrlQuery songQuery(const QVariantMap &songValue, const QVariantMap &extraValues) {
    const QVariantMap song = normalizeSong(songValue);
    QUrlQuery query;
    for (const QString &key : {QStringLiteral("id"), QStringLiteral("source"),
                               QStringLiteral("name"), QStringLiteral("artist"),
                               QStringLiteral("album"), QStringLiteral("duration"),
                               QStringLiteral("cover")}) {
        const QString value = song.value(key).toString();
        if (!value.isEmpty() && value != QStringLiteral("0"))
            query.addQueryItem(key, value);
    }
    const QVariantMap extra = song.value(QStringLiteral("extra")).toMap();
    if (!extra.isEmpty()) {
        query.addQueryItem(QStringLiteral("extra"),
                           QString::fromUtf8(QJsonDocument::fromVariant(extra).toJson(
                               QJsonDocument::Compact)));
    }
    for (auto it = extraValues.cbegin(); it != extraValues.cend(); ++it)
        query.addQueryItem(it.key(), it.value().toString());
    return query;
}

QString encodedQuery(const QUrlQuery &query) {
    return query.query(QUrl::FullyEncoded);
}

QString songKey(const QVariantMap &song) {
    const QVariantMap normalized = normalizeSong(song);
    return normalized.value(QStringLiteral("source")).toString() + QLatin1Char(':') +
           normalized.value(QStringLiteral("id")).toString();
}

QList<QVariantMap> variantMaps(const QVariant &value) {
    QList<QVariantMap> output;
    for (const QVariant &entry : value.toList()) {
        if (entry.canConvert<QVariantMap>())
            output.append(entry.toMap());
    }
    return output;
}

QVariantList toVariantList(const QList<QVariantMap> &values) {
    QVariantList output;
    output.reserve(values.size());
    for (const QVariantMap &value : values)
        output.append(value);
    return output;
}

}  // namespace melodex
