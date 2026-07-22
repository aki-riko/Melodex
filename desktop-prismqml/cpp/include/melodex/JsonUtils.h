#pragma once

#include <QUrl>
#include <QUrlQuery>
#include <QVariantList>
#include <QVariantMap>

namespace melodex {

QVariantMap normalizeSong(const QVariantMap &value);
QVariantMap normalizeCollection(const QVariantMap &value);
QVariantMap songWritePayload(const QVariantMap &value);
QUrlQuery songQuery(const QVariantMap &song, const QVariantMap &extraValues = {});
QString encodedQuery(const QUrlQuery &query);
QString songKey(const QVariantMap &song);
QList<QVariantMap> variantMaps(const QVariant &value);
QVariantList toVariantList(const QList<QVariantMap> &values);

}  // namespace melodex
